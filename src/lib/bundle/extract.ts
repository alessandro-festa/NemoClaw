// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { sha256Hex } from "./verify";

// Shells out to `tar -xzf` rather than pulling in a tar npm dep — keeps
// the dependency surface minimal and matches NemoClaw's existing shell-out
// posture (docker, openshell, etc.). tar is available on every supported
// platform (macOS, Linux, WSL2).
export function extractTarball(bundlePath: string, destDir: string): void {
  const r = spawnSync("tar", ["-xzf", bundlePath, "-C", destDir], { stdio: "pipe" });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString() ?? "";
    throw new Error(`tar -xzf failed (exit ${r.status}): ${stderr.trim()}`);
  }
}

// Reject any path that escapes destDir via symlink or .. — defense in
// depth even though the Go exporter sorts + validates paths.
export function assertSafePath(destDir: string, candidate: string): void {
  const abs = resolve(destDir, candidate);
  const rel = relative(destDir, abs);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(rel) === abs) {
    throw new Error(`unsafe path "${candidate}" escapes extraction dir`);
  }
}

// Walk every regular file under root, return path-relative-to-root → sha256 hex.
// Skips manifest.json and manifest.sig — those are verified separately.
export function hashExtractedFiles(
  root: string,
  skip: Set<string> = new Set(["manifest.json", "manifest.sig"]),
): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = `${dir}/${name}`;
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, abs);
      if (skip.has(rel)) continue;
      out.set(rel, sha256Hex(readFileSync(abs)));
    }
  };
  walk(root);
  return out;
}

export function readManifestPair(stagingDir: string): { manifestRaw: Buffer; signatureRaw: Buffer } {
  return {
    manifestRaw: readFileSync(`${stagingDir}/manifest.json`),
    signatureRaw: readFileSync(`${stagingDir}/manifest.sig`),
  };
}

export function rmStaging(stagingDir: string): void {
  rmSync(stagingDir, { recursive: true, force: true });
}
