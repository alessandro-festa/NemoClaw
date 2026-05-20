// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { resolveNemoclawLocalDir } from "../state/paths";

export interface LocalSession {
  sessionId: string;
  deployment: string;
  dir: string;
}

export function newSessionId(): string {
  return randomUUID();
}

export function localSessionDir(deployment: string, sessionId: string): string {
  return join(resolveNemoclawLocalDir(), `${deployment}-${sessionId}`);
}

// Promote a verified staging directory into the canonical local-session
// dir under ~/.nemoclaw/local/<deployment>-<sessionId>/. Done as an atomic
// rename so a half-extracted bundle never appears in the local namespace.
export function promoteStagingToSession(stagingDir: string, sessionDir: string): void {
  mkdirSync(resolveNemoclawLocalDir(), { recursive: true, mode: 0o700 });
  renameSync(stagingDir, sessionDir);
}
