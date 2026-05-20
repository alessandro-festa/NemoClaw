// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// TypeScript mirror of aif-nc/internal/bundle/importer.go. Must produce
// the same canonical signed payload byte-for-byte as the Go exporter.
// See docs/airgapped-bundle-spec.md in aif-nc.

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { BUNDLE_VERSION, type FileEntry, type Manifest } from "./types";

export class BundleVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleVerifyError";
  }
}

export function publicKeyFingerprint(rawEd25519: Buffer): string {
  if (rawEd25519.length !== 32) {
    throw new BundleVerifyError(`ed25519 public key must be 32 bytes, got ${rawEd25519.length}`);
  }
  return "sha256:" + createHash("sha256").update(rawEd25519).digest("hex");
}

// canonicalSignedPayload mirrors Go's bundle.CanonicalSignedPayload:
//   SHA256(manifest.json raw bytes) || SHA256(sorted "path|sha256" entries joined by LF, no trailing newline)
// The Go implementation is the canonical reference — the prose in the spec
// doc differs (suggests trailing \n per entry); Go wins.
export function canonicalSignedPayload(manifestRaw: Buffer, files: FileEntry[]): Buffer {
  const manifestHash = createHash("sha256").update(manifestRaw).digest();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = sorted.map((e) => `${e.path}|${e.sha256}`).join("\n");
  const filesHash = createHash("sha256").update(lines).digest();
  return Buffer.concat([manifestHash, filesHash]);
}

// Wrap a raw 32-byte ed25519 public key in the ASN.1 SPKI DER envelope so
// Node's crypto module accepts it. The 12-byte prefix is the fixed SPKI
// algorithm identifier for ed25519 (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function importRawEd25519PublicKey(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new BundleVerifyError(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export interface TrustedKey {
  filePath: string;
  fingerprint: string;
  rawKey: Buffer;
}

// Load every pinned key under ~/.nemoclaw/trusted-keys/. Each file is the
// raw 32-byte ed25519 public key written by `nemoclaw onboard`.
export function loadTrustedKeys(trustedKeysDir: string): TrustedKey[] {
  let entries: string[];
  try {
    entries = readdirSync(trustedKeysDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: TrustedKey[] = [];
  for (const name of entries) {
    if (!name.endsWith(".pub")) continue;
    const filePath = join(trustedKeysDir, name);
    const raw = readFileSync(filePath);
    if (raw.length !== 32) continue;
    out.push({ filePath, fingerprint: publicKeyFingerprint(raw), rawKey: raw });
  }
  return out;
}

export interface VerifyInput {
  manifestRaw: Buffer;
  signatureRaw: Buffer;
  pubKey: Buffer;
}

// Parses the manifest, asserts version + fingerprint + ed25519 signature.
// Does NOT touch the rest of the bundle — caller has already separated
// manifest.json + manifest.sig from the tarball. File-hash verification is
// in verifyFileHashes() below.
export function verifyManifest(input: VerifyInput): Manifest {
  const manifest = JSON.parse(input.manifestRaw.toString("utf8")) as Manifest;
  if (manifest.version !== BUNDLE_VERSION) {
    throw new BundleVerifyError(
      `unsupported bundle version "${manifest.version}" (this CLI supports "${BUNDLE_VERSION}")`,
    );
  }
  const wantFp = publicKeyFingerprint(input.pubKey);
  if (manifest.signature.publicKeyFingerprint !== wantFp) {
    throw new BundleVerifyError(
      `bundle signed by unknown key (manifest fingerprint ${manifest.signature.publicKeyFingerprint}, pinned key fingerprint ${wantFp})`,
    );
  }
  const payload = canonicalSignedPayload(input.manifestRaw, manifest.files);
  const keyObj = importRawEd25519PublicKey(input.pubKey);
  const ok = verify(null, payload, keyObj, input.signatureRaw);
  if (!ok) {
    throw new BundleVerifyError("ed25519 signature verification failed");
  }
  return manifest;
}

// verifyFileHashes asserts that the files extracted from the bundle match
// the sha256 entries declared in manifest.files — neither side has extras.
export function verifyFileHashes(declared: FileEntry[], seen: Map<string, string>): void {
  const declaredMap = new Map(declared.map((e) => [e.path, e.sha256]));
  for (const [path, gotHash] of seen) {
    const want = declaredMap.get(path);
    if (!want) throw new BundleVerifyError(`file "${path}" exists in bundle but isn't in manifest.files`);
    if (want !== gotHash) {
      throw new BundleVerifyError(`file "${path}" hash mismatch: got ${gotHash}, want ${want}`);
    }
  }
  for (const path of declaredMap.keys()) {
    if (!seen.has(path)) {
      throw new BundleVerifyError(`manifest.files declares "${path}" but it's missing from the bundle`);
    }
  }
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
