// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractTarball,
  hashExtractedFiles,
  readManifestPair,
  rmStaging,
} from "../bundle/extract";
import {
  BundleVerifyError,
  loadTrustedKeys,
  publicKeyFingerprint,
  verifyFileHashes,
  verifyManifest,
} from "../bundle/verify";
import { dockerPull } from "../adapters/docker/pull";
import { dockerRun } from "../adapters/docker/run";
import {
  localSessionDir,
  newSessionId,
  promoteStagingToSession,
} from "../local/session";
import { ensureSupervisorBinary, resolveSupervisorImage } from "../local/supervisor-bin";
import { resolveNemoclawTrustedKeysDir } from "../state/paths";

export interface RunLocalOptions {
  bundlePath: string;
  trustKeyPath?: string;   // Escape hatch: trust a single key file directly (for testing).
  allowPull?: boolean;     // Permit `docker pull` for sandbox image AND supervisor image when absent.
  shell?: string;          // User-facing command inside the sandbox; default /bin/bash.
  supervisorImage?: string; // Override the supervisor OCI image (env: NEMOCLAW_SUPERVISOR_IMAGE).
}

export interface RunLocalResult {
  sessionDir: string;
  deployment: string;
  sandboxImageRef: string;
  supervisorImage: string;
}

// runLocal: verify, extract, launch. The full pipeline for `nemoclaw
// run-local <bundle>`. Caller owns process exit semantics.
export function runLocal(opts: RunLocalOptions): RunLocalResult {
  if (!existsSync(opts.bundlePath)) {
    throw new Error(`bundle not found: ${opts.bundlePath}`);
  }

  const stagingDir = mkdtempSync(join(tmpdir(), "nemoclaw-bundle-"));
  try {
    extractTarball(opts.bundlePath, stagingDir);

    const { manifestRaw, signatureRaw } = readManifestPair(stagingDir);
    const trustedKeys = collectCandidateKeys(opts.trustKeyPath);
    if (trustedKeys.length === 0) {
      throw new BundleVerifyError(
        `no trusted signing key available. Run \`nemoclaw onboard\` to pin the operator's signing key, or pass --trust-key <file>.`,
      );
    }

    // Parse manifest just enough to find the right pinned key by fingerprint.
    let manifestSignatureFp: string;
    try {
      manifestSignatureFp = JSON.parse(manifestRaw.toString("utf8"))?.signature?.publicKeyFingerprint;
    } catch (err) {
      throw new BundleVerifyError(`manifest.json is not valid JSON: ${(err as Error).message}`);
    }
    const matchingKey = trustedKeys.find((k) => k.fingerprint === manifestSignatureFp);
    if (!matchingKey) {
      throw new BundleVerifyError(
        `bundle was signed by ${manifestSignatureFp}, none of the pinned keys match. Available: ${trustedKeys.map((k) => k.fingerprint).join(", ") || "(none)"}`,
      );
    }

    const manifest = verifyManifest({ manifestRaw, signatureRaw, pubKey: matchingKey.rawKey });
    const seenHashes = hashExtractedFiles(stagingDir);
    verifyFileHashes(manifest.files, seenHashes);

    // Verification passed — promote staging to the canonical session dir.
    const sessionId = newSessionId();
    const sessionDir = localSessionDir(manifest.deployment.name, sessionId);
    promoteStagingToSession(stagingDir, sessionDir);

    // Image handling. v1 default is embedded=false (operator pod has no
    // container runtime). Require --allow-pull to fetch from a registry,
    // per spec line 81.
    const img = manifest.sandboxImage;
    if (img.embedded) {
      // For embedded bundles, sandbox-image.tar lives next to manifest.json.
      // (Implementing the `docker load` path is deferred — we currently emit
      // bundles with embedded=false.)
      throw new Error(
        `sandboxImage.embedded=true is not yet supported by run-local (v1 ships embedded=false bundles)`,
      );
    }
    if (!opts.allowPull) {
      throw new Error(
        `bundle has sandboxImage.embedded=false; first run requires --allow-pull to fetch ${img.ref}`,
      );
    }

    // Bundle must carry policy/rules.rego (US-154 — older bundles don't).
    if (!manifest.policy.rulesPath) {
      throw new Error(
        `bundle is missing policy.rulesPath — re-export from an operator that includes the rego file (US-154)`,
      );
    }

    // Side-load supervisor binary from its OCI image. Same image the
    // operator uses in cluster mode (kept in sync via env override).
    const supervisorImage = opts.supervisorImage ?? resolveSupervisorImage();
    const supervisorBin = ensureSupervisorBinary({
      image: supervisorImage,
      allowPull: opts.allowPull,
    });

    dockerPull(img.ref);

    const shell = opts.shell ?? "/bin/bash";
    const containerName = `nemoclaw-local-${manifest.deployment.name}-${sessionId.slice(0, 8)}`;
    const auditDir = join(sessionDir, "audit");
    mkdirSync(auditDir, { recursive: true, mode: 0o700 });

    dockerRun(
      [
        "run",
        "--rm",
        "-it",
        "--name", containerName,
        // CAP_NET_ADMIN + CAP_SYS_ADMIN: supervisor sets up an isolated
        // child network namespace + nftables ruleset inside the container.
        // Without these caps the supervisor errors out at startup (see
        // OpenShell/crates/openshell-sandbox/src/lib.rs:537-539).
        "--cap-add=NET_ADMIN",
        "--cap-add=SYS_ADMIN",
        "-v", `${supervisorBin}:/opt/openshell/bin/openshell-sandbox:ro`,
        "-v", `${join(sessionDir, "policy")}:/etc/openshell/policy:ro`,
        "-v", `${auditDir}:/var/log:rw`,
        "--entrypoint", "/opt/openshell/bin/openshell-sandbox",
        img.ref,
        "--policy-rules", "/etc/openshell/policy/rules.rego",
        "--policy-data", "/etc/openshell/policy/effective.yaml",
        "--",
        shell,
      ],
      { stdio: "inherit" },
    );

    return {
      sessionDir,
      deployment: manifest.deployment.name,
      sandboxImageRef: img.ref,
      supervisorImage,
    };
  } catch (err) {
    rmStaging(stagingDir);
    throw err;
  }
}

function collectCandidateKeys(explicitPath?: string) {
  if (explicitPath) {
    const raw = readFileSync(explicitPath);
    if (raw.length !== 32) {
      throw new BundleVerifyError(
        `--trust-key file ${explicitPath} is ${raw.length} bytes; expected 32 (raw ed25519 public key)`,
      );
    }
    return [{ filePath: explicitPath, fingerprint: publicKeyFingerprint(raw), rawKey: raw }];
  }
  const dir = resolveNemoclawTrustedKeysDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return loadTrustedKeys(dir);
}
