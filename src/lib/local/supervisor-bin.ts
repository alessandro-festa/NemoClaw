// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Side-loads the openshell-sandbox supervisor binary from its OCI image
// onto the host filesystem, where `run-local` mounts it into the sandbox
// container. Mirrors what the aif-nc operator does in cluster mode via an
// initContainer — see internal/controller/isolation.go:1116-1130.
//
// US-154. Keep DEFAULT_SUPERVISOR_IMAGE in sync with isolation.go's
// SupervisorImage var when bumping.

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { dockerCp, dockerCreate, dockerForceRm } from "../adapters/docker/container";
import { dockerImageInspectFormat } from "../adapters/docker/inspect";
import { dockerPull } from "../adapters/docker/pull";
import { resolveNemoclawHomeDir } from "../state/paths";

export const DEFAULT_SUPERVISOR_IMAGE = "ghcr.io/alessandro-festa/openshell-supervisor:netlink-allow";
export const SUPERVISOR_BINARY_IN_IMAGE = "/openshell-sandbox";

export function resolveSupervisorCacheDir(): string {
  return join(resolveNemoclawHomeDir(), "supervisor-bin");
}

export function resolveSupervisorImage(): string {
  return process.env.NEMOCLAW_SUPERVISOR_IMAGE ?? DEFAULT_SUPERVISOR_IMAGE;
}

export interface EnsureSupervisorOptions {
  image?: string;
  allowPull?: boolean;
}

// ensureSupervisorBinary returns an absolute path to a cached supervisor
// binary on the host. On cache miss it pulls the supervisor image (if
// allowed), spins a throwaway container with `docker create`, copies the
// binary out with `docker cp`, then removes the container. Subsequent
// calls with the same image digest are O(1).
export function ensureSupervisorBinary(opts: EnsureSupervisorOptions = {}): string {
  const image = opts.image ?? resolveSupervisorImage();

  let imageId = dockerImageInspectFormat("{{.Id}}", image, { ignoreError: true });
  if (!imageId) {
    if (!opts.allowPull) {
      throw new Error(
        `supervisor image ${image} not present locally; pass --allow-pull to fetch it`,
      );
    }
    dockerPull(image);
    imageId = dockerImageInspectFormat("{{.Id}}", image);
  }

  const cacheKey = imageId.replace(/^sha256:/, "");
  const cacheDir = join(resolveSupervisorCacheDir(), cacheKey);
  const binPath = join(cacheDir, "openshell-sandbox");
  if (existsSync(binPath)) return binPath;

  mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
  const tmpName = `nemoclaw-supbin-${randomUUID().slice(0, 8)}`;
  dockerCreate(tmpName, image);
  try {
    dockerCp(`${tmpName}:${SUPERVISOR_BINARY_IN_IMAGE}`, binPath);
  } finally {
    dockerForceRm(tmpName, { ignoreError: true });
  }
  chmodSync(binPath, 0o755);
  return binPath;
}
