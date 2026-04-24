// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard chain health verification — checks all links of the delivery
 * chain and produces a per-link diagnosis.
 *
 * All external dependencies are injected for testability.
 */

import type { DashboardDeliveryChain } from "./dashboard-contract";

/** Dependencies for health verification — all external operations injected. */
export interface DashboardHealthDeps {
  /** Run a command inside the sandbox. Returns stdout/status or null if unreachable. */
  executeSandboxCommand: (
    sandboxName: string,
    script: string,
  ) => { status: number; stdout: string } | null;
  /** Capture `openshell forward list` output. Returns null on failure. */
  captureForwardList: () => string | null;
  /** Download and parse openclaw.json from the sandbox. Returns null on failure. */
  downloadSandboxConfig: (
    sandboxName: string,
  ) => { gateway?: { controlUi?: { allowedOrigins?: string[] } } } | null;
}

/** Status of a single link in the delivery chain. */
export interface LinkStatus {
  ok: boolean;
  detail: string;
}

/** Status of the entire dashboard delivery chain. */
export interface ChainStatus {
  healthy: boolean;
  links: {
    gateway: LinkStatus;
    forward: LinkStatus;
    cors: LinkStatus;
  };
  diagnosis: string;
}

/** HTTP status codes that mean the gateway is alive (even if auth-gated). */
const ALIVE_STATUS_CODES = new Set(["200", "401"]);

/**
 * Extract the origin (scheme + host + port) from a URL string.
 */
function extractOrigin(urlStr: string): string | null {
  try {
    return new URL(urlStr).origin;
  } catch {
    return null;
  }
}

/**
 * Verify Link 1: Gateway process is running inside the sandbox.
 * Probes /health endpoint — accepts 200 or 401 as "alive".
 */
function verifyGateway(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: DashboardHealthDeps,
): LinkStatus {
  const script = `curl -so /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${chain.port}${chain.healthEndpoint} 2>/dev/null || echo 000`;
  const result = deps.executeSandboxCommand(sandboxName, script);
  if (!result) {
    return { ok: false, detail: "sandbox unreachable" };
  }
  const status = result.stdout.trim();
  if (ALIVE_STATUS_CODES.has(status)) {
    return { ok: true, detail: `HTTP ${status}` };
  }
  return { ok: false, detail: `HTTP ${status} — gateway not responding` };
}

/**
 * Verify Link 2: Port forward is active between host and sandbox.
 * Parses `openshell forward list` output for a matching row.
 */
function verifyForward(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: DashboardHealthDeps,
): LinkStatus {
  const output = deps.captureForwardList();
  if (!output) {
    return { ok: false, detail: `no forward found for port ${chain.port}` };
  }
  const portStr = String(chain.port);
  // openshell forward list columns: SANDBOX  BIND  PORT  PID  STATUS
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[2] === portStr) {
      if (parts[0] === sandboxName) {
        return { ok: true, detail: `PID ${parts[3] ?? "?"} on ${parts[1] ?? "?"}` };
      }
      return {
        ok: false,
        detail: `port ${portStr} owned by ${parts[0]} (conflict)`,
      };
    }
  }
  return { ok: false, detail: `no forward found for port ${chain.port}` };
}

/**
 * Verify Link 3: CORS allowedOrigins includes the dashboard access URL origin.
 */
function verifyCors(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: DashboardHealthDeps,
): LinkStatus {
  const config = deps.downloadSandboxConfig(sandboxName);
  if (!config) {
    return { ok: false, detail: "could not download openclaw.json" };
  }
  const origins = config.gateway?.controlUi?.allowedOrigins ?? [];
  const accessOrigin = extractOrigin(chain.accessUrl);
  if (!accessOrigin) {
    return { ok: false, detail: "could not parse accessUrl origin" };
  }
  if (origins.includes(accessOrigin)) {
    return { ok: true, detail: `allowedOrigins includes ${accessOrigin}` };
  }
  return { ok: false, detail: `missing ${accessOrigin} in allowedOrigins` };
}

/**
 * Verify all links of the dashboard delivery chain.
 * Returns a per-link diagnosis.
 */
export function verifyDashboardChain(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: DashboardHealthDeps,
): ChainStatus {
  const gateway = verifyGateway(sandboxName, chain, deps);
  const forward = verifyForward(sandboxName, chain, deps);
  const cors = verifyCors(sandboxName, chain, deps);

  const links = { gateway, forward, cors };
  const healthy = gateway.ok && forward.ok && cors.ok;

  const failures = Object.entries(links)
    .filter(([, link]) => !link.ok)
    .map(([name, link]) => `${name}: ${link.detail}`);
  const diagnosis = failures.join("; ");

  return { healthy, links, diagnosis };
}
