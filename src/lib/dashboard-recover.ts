// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard chain recovery — link-aware, idempotent recovery that only
 * fixes what's broken. Calls verifyDashboardChain() first, then fixes
 * only broken links.
 *
 * All external dependencies are injected for testability.
 */

import type { DashboardDeliveryChain } from "./dashboard-contract";
import type { DashboardHealthDeps, ChainStatus } from "./dashboard-health";
import { verifyDashboardChain } from "./dashboard-health";

/** Extended dependencies for recovery — adds repair operations to health deps. */
export interface DashboardRecoverDeps extends DashboardHealthDeps {
  /** Restart the gateway process inside the sandbox. Returns true on success. */
  restartGateway: (sandboxName: string, port: number, agent: unknown) => boolean;
  /** Stop the port forward for the given port. */
  stopForward: (port: number) => void;
  /** Start a port forward to the sandbox. */
  startForward: (forwardTarget: string, sandboxName: string) => void;
  /** Get the session agent for the sandbox, or null for OpenClaw. */
  getSessionAgent: (sandboxName: string) => unknown;
}

/** Result of a recovery attempt. */
export interface RecoverResult {
  /** Whether any recovery actions were attempted. */
  attempted: boolean;
  /** Chain status before recovery. */
  before: ChainStatus;
  /** Chain status after recovery (null if not attempted). */
  after: ChainStatus | null;
  /** Descriptions of actions taken. */
  actions: string[];
}

/**
 * Diagnose the dashboard chain and recover broken links.
 *
 * Recovery order:
 * 1. Gateway — restart if down
 * 2. Forward — stop + start if missing
 * 3. CORS — diagnose only (rebuild required)
 *
 * Idempotent: if the chain is already healthy, returns immediately.
 */
export function recoverDashboardChain(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: DashboardRecoverDeps,
): RecoverResult {
  const before = verifyDashboardChain(sandboxName, chain, deps);

  if (before.healthy) {
    return { attempted: false, before, after: null, actions: [] };
  }

  const actions: string[] = [];

  // Link 1: Gateway
  if (!before.links.gateway.ok) {
    const agent = deps.getSessionAgent(sandboxName);
    deps.restartGateway(sandboxName, chain.port, agent);
    actions.push("restarted gateway");
  }

  // Link 2: Forward
  if (!before.links.forward.ok) {
    deps.stopForward(chain.port);
    deps.startForward(chain.forwardTarget, sandboxName);
    actions.push("re-established forward");
  }

  // Link 3: CORS — diagnose only
  if (!before.links.cors.ok) {
    actions.push(`CORS mismatch — rebuild required (${before.links.cors.detail})`);
  }

  // Re-verify after recovery
  const after = verifyDashboardChain(sandboxName, chain, deps);

  return { attempted: true, before, after, actions };
}
