// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Mirrors aif-nc/internal/bundle/manifest.go. Both implementations MUST
// compute the same canonical signed payload bit-for-bit; see verify.ts.

export const BUNDLE_VERSION = "1";
export const MANIFEST_PATH = "manifest.json";
export const SIGNATURE_PATH = "manifest.sig";
export const SANDBOX_IMAGE_TAR_PATH = "sandbox-image.tar";
export const SIGNATURE_SCHEME = "ed25519";

export interface DeploymentRef {
  name: string;
  namespace: string;
  uid: string;
  generation: number;
}

export interface BlueprintRef {
  name: string;
  version: string;
  digest?: string;
}

export interface SandboxImageRef {
  ref: string;
  embedded: boolean;
  tarPath?: string;
}

export interface PolicyRef {
  snapshotPath: string;
  tier?: string;
}

export interface Cursor {
  deploymentGeneration: number;
  blueprintGeneration?: number;
  policyConfigMapResourceVersion?: string;
}

export interface FileEntry {
  path: string;
  sha256: string;
}

export interface SignatureMeta {
  scheme: string;
  publicKeyFingerprint: string;
}

export interface Manifest {
  version: string;
  bundleId: string;
  createdAt: string;
  deployment: DeploymentRef;
  blueprint: BlueprintRef;
  sandboxImage: SandboxImageRef;
  policy: PolicyRef;
  cursor: Cursor;
  files: FileEntry[];
  signature: SignatureMeta;
}
