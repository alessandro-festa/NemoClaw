// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BundleVerifyError,
  canonicalSignedPayload,
  importRawEd25519PublicKey,
  publicKeyFingerprint,
  verifyFileHashes,
  verifyManifest,
} from "./verify";
import type { FileEntry, Manifest } from "./types";

function freshKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // SPKI DER for ed25519 = 12-byte algorithm prefix + 32-byte raw key.
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { rawPub: Buffer.from(rawPub), privateKey };
}

function buildSignedBundle(files: FileEntry[]) {
  const { rawPub, privateKey } = freshKeyPair();
  const fp = publicKeyFingerprint(rawPub);
  const manifest: Manifest = {
    version: "1",
    bundleId: "00000000-0000-0000-0000-000000000001",
    createdAt: "2026-05-19T00:00:00Z",
    deployment: { name: "demo", namespace: "aif-system", uid: "u1", generation: 1 },
    blueprint: { name: "bp", version: "0.1.0" },
    sandboxImage: { ref: "ghcr.io/example/img@sha256:abc", embedded: false },
    policy: { snapshotPath: "policy/effective.yaml", tier: "default" },
    cursor: { deploymentGeneration: 1 },
    files,
    signature: { scheme: "ed25519", publicKeyFingerprint: fp },
  };
  const manifestRaw = Buffer.from(JSON.stringify(manifest), "utf8");
  const payload = canonicalSignedPayload(manifestRaw, files);
  const signatureRaw = Buffer.from(sign(null, payload, privateKey));
  return { manifestRaw, signatureRaw, rawPub, manifest };
}

describe("canonicalSignedPayload", () => {
  it("is 64 bytes (two sha256s concatenated)", () => {
    const p = canonicalSignedPayload(Buffer.from("{}"), []);
    expect(p.length).toBe(64);
  });

  it("is order-independent — sorts by path before hashing", () => {
    const m = Buffer.from("{}");
    const a = canonicalSignedPayload(m, [
      { path: "b.txt", sha256: "bb" },
      { path: "a.txt", sha256: "aa" },
    ]);
    const b = canonicalSignedPayload(m, [
      { path: "a.txt", sha256: "aa" },
      { path: "b.txt", sha256: "bb" },
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it("changes when any file hash changes", () => {
    const m = Buffer.from("{}");
    const a = canonicalSignedPayload(m, [{ path: "a.txt", sha256: "aa" }]);
    const b = canonicalSignedPayload(m, [{ path: "a.txt", sha256: "ab" }]);
    expect(a.equals(b)).toBe(false);
  });

  it("changes when manifest bytes change", () => {
    const a = canonicalSignedPayload(Buffer.from("{}"), []);
    const b = canonicalSignedPayload(Buffer.from('{ }'), []);
    expect(a.equals(b)).toBe(false);
  });
});

describe("publicKeyFingerprint", () => {
  it("formats as sha256:<64hex>", () => {
    const fp = publicKeyFingerprint(Buffer.alloc(32, 0));
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects non-32-byte keys", () => {
    expect(() => publicKeyFingerprint(Buffer.alloc(16, 0))).toThrow(BundleVerifyError);
  });
});

describe("importRawEd25519PublicKey", () => {
  it("accepts a 32-byte key", () => {
    const { rawPub } = freshKeyPair();
    const obj = importRawEd25519PublicKey(rawPub);
    expect(obj.asymmetricKeyType).toBe("ed25519");
  });

  it("rejects wrong sizes", () => {
    expect(() => importRawEd25519PublicKey(Buffer.alloc(31, 0))).toThrow(BundleVerifyError);
  });
});

describe("verifyManifest", () => {
  it("accepts a freshly-signed bundle", () => {
    const { manifestRaw, signatureRaw, rawPub } = buildSignedBundle([
      { path: "policy/effective.yaml", sha256: "abc" },
      { path: "blueprint.yaml", sha256: "def" },
    ]);
    const m = verifyManifest({ manifestRaw, signatureRaw, pubKey: rawPub });
    expect(m.deployment.name).toBe("demo");
  });

  it("rejects a tampered signature", () => {
    const { manifestRaw, signatureRaw, rawPub } = buildSignedBundle([
      { path: "a", sha256: "1" },
    ]);
    const bad = Buffer.from(signatureRaw);
    bad[0] ^= 0xff;
    expect(() => verifyManifest({ manifestRaw, signatureRaw: bad, pubKey: rawPub })).toThrow(
      BundleVerifyError,
    );
  });

  it("rejects when fingerprint doesn't match the supplied key", () => {
    const { manifestRaw, signatureRaw } = buildSignedBundle([{ path: "a", sha256: "1" }]);
    const otherPub = freshKeyPair().rawPub;
    expect(() => verifyManifest({ manifestRaw, signatureRaw, pubKey: otherPub })).toThrow(
      BundleVerifyError,
    );
  });

  it("rejects unsupported manifest version", () => {
    const { manifestRaw, signatureRaw, rawPub, manifest } = buildSignedBundle([
      { path: "a", sha256: "1" },
    ]);
    const bumped = Buffer.from(JSON.stringify({ ...manifest, version: "2" }), "utf8");
    // Signature is now invalid (bytes changed) — but the version check fires first.
    expect(() =>
      verifyManifest({ manifestRaw: bumped, signatureRaw, pubKey: rawPub }),
    ).toThrow(/unsupported bundle version/);
    void manifestRaw;
  });
});

describe("verifyFileHashes", () => {
  it("passes when sets match", () => {
    expect(() =>
      verifyFileHashes(
        [{ path: "a", sha256: "1" }],
        new Map([["a", "1"]]),
      ),
    ).not.toThrow();
  });

  it("fails on hash mismatch", () => {
    expect(() =>
      verifyFileHashes(
        [{ path: "a", sha256: "1" }],
        new Map([["a", "2"]]),
      ),
    ).toThrow(/hash mismatch/);
  });

  it("fails on extra file in bundle", () => {
    expect(() =>
      verifyFileHashes(
        [{ path: "a", sha256: "1" }],
        new Map([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
    ).toThrow(/isn't in manifest.files/);
  });

  it("fails on missing file in bundle", () => {
    expect(() =>
      verifyFileHashes(
        [
          { path: "a", sha256: "1" },
          { path: "b", sha256: "2" },
        ],
        new Map([["a", "1"]]),
      ),
    ).toThrow(/missing from the bundle/);
  });
});
