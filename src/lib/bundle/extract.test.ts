// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSafePath,
  extractTarball,
  hashExtractedFiles,
  readManifestPair,
} from "./extract";
import {
  canonicalSignedPayload,
  publicKeyFingerprint,
  sha256Hex,
  verifyFileHashes,
  verifyManifest,
} from "./verify";
import type { FileEntry, Manifest } from "./types";

describe("assertSafePath", () => {
  it("accepts a normal path", () => {
    expect(() => assertSafePath("/tmp/dest", "policy/effective.yaml")).not.toThrow();
  });
  it("rejects parent traversal", () => {
    expect(() => assertSafePath("/tmp/dest", "../escape")).toThrow();
  });
  it("rejects absolute path", () => {
    expect(() => assertSafePath("/tmp/dest", "/etc/passwd")).toThrow();
  });
});

describe("hashExtractedFiles", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "extract-test-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("walks recursively and skips manifest files by default", () => {
    writeFileSync(join(root, "manifest.json"), "{}");
    writeFileSync(join(root, "manifest.sig"), "x");
    mkdirSync(join(root, "policy"));
    writeFileSync(join(root, "policy", "effective.yaml"), "version: 1\n");
    writeFileSync(join(root, "blueprint.yaml"), "name: bp\n");

    const seen = hashExtractedFiles(root);
    expect([...seen.keys()].sort()).toEqual(["blueprint.yaml", "policy/effective.yaml"]);
    expect(seen.get("blueprint.yaml")).toBe(sha256Hex(Buffer.from("name: bp\n")));
  });
});

// Full pipeline: build a real tarball, extract, verify signature, verify hashes.
// This is the integration glue that the unit tests in verify.test.ts skip.
describe("bundle round-trip via tarball", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "bundle-rt-"));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("extracts + verifies a freshly-built signed bundle", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(12));
    const fp = publicKeyFingerprint(rawPub);

    const blueprintBytes = Buffer.from("name: round-trip-bp\n");
    const policyBytes = Buffer.from("version: 1\nallow: []\n");
    const regoBytes = Buffer.from("package sandbox\n\ndefault allow = false\n");

    const stagingSrc = join(workDir, "src");
    mkdirSync(join(stagingSrc, "policy"), { recursive: true });
    writeFileSync(join(stagingSrc, "blueprint.yaml"), blueprintBytes);
    writeFileSync(join(stagingSrc, "policy", "effective.yaml"), policyBytes);
    writeFileSync(join(stagingSrc, "policy", "rules.rego"), regoBytes);

    const files: FileEntry[] = [
      { path: "blueprint.yaml", sha256: sha256Hex(blueprintBytes) },
      { path: "policy/effective.yaml", sha256: sha256Hex(policyBytes) },
      { path: "policy/rules.rego", sha256: sha256Hex(regoBytes) },
    ];
    const manifest: Manifest = {
      version: "1",
      bundleId: "00000000-0000-0000-0000-000000000099",
      createdAt: "2026-05-19T00:00:00Z",
      deployment: { name: "rt-demo", namespace: "aif-system", uid: "u9", generation: 1 },
      blueprint: { name: "round-trip-bp", version: "0.1.0" },
      sandboxImage: { ref: "ghcr.io/example/img@sha256:abc", embedded: false },
      policy: { snapshotPath: "policy/effective.yaml", rulesPath: "policy/rules.rego", tier: "default" },
      cursor: { deploymentGeneration: 1 },
      files,
      signature: { scheme: "ed25519", publicKeyFingerprint: fp },
    };
    const manifestRaw = Buffer.from(JSON.stringify(manifest), "utf8");
    writeFileSync(join(stagingSrc, "manifest.json"), manifestRaw);
    const signatureRaw = Buffer.from(sign(null, canonicalSignedPayload(manifestRaw, files), privateKey));
    writeFileSync(join(stagingSrc, "manifest.sig"), signatureRaw);

    const bundlePath = join(workDir, "rt-demo.nemoclaw-bundle");
    const tarOut = spawnSync("tar", ["-czf", bundlePath, "-C", stagingSrc, "."], { stdio: "pipe" });
    expect(tarOut.status).toBe(0);

    const extractDest = join(workDir, "out");
    mkdirSync(extractDest);
    extractTarball(bundlePath, extractDest);

    const pair = readManifestPair(extractDest);
    const m = verifyManifest({
      manifestRaw: pair.manifestRaw,
      signatureRaw: pair.signatureRaw,
      pubKey: rawPub,
    });
    expect(m.deployment.name).toBe("rt-demo");

    const seenHashes = hashExtractedFiles(extractDest);
    expect(() => verifyFileHashes(m.files, seenHashes)).not.toThrow();
  });
});
