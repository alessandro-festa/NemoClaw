// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import { recoverDashboardChain } from "../../dist/lib/dashboard-recover";
import { buildChain } from "../../dist/lib/dashboard-contract";

function buildMockDeps(overrides = {}) {
  return {
    // Health deps
    executeSandboxCommand: vi.fn().mockReturnValue({ status: 0, stdout: "200" }),
    captureForwardList: vi.fn().mockReturnValue("my-sandbox  127.0.0.1  18789  12345  running"),
    downloadSandboxConfig: vi.fn().mockReturnValue({
      gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } },
    }),
    // Recovery deps
    restartGateway: vi.fn().mockReturnValue(true),
    stopForward: vi.fn(),
    startForward: vi.fn(),
    getSessionAgent: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

describe("recoverDashboardChain", () => {
  const chain = buildChain();

  it("does not attempt recovery when chain is healthy", () => {
    const deps = buildMockDeps();
    const result = recoverDashboardChain("my-sandbox", chain, deps);
    expect(result.attempted).toBe(false);
    expect(deps.restartGateway).not.toHaveBeenCalled();
    expect(deps.stopForward).not.toHaveBeenCalled();
    expect(deps.startForward).not.toHaveBeenCalled();
  });

  it("restarts gateway when gateway is down", () => {
    let callCount = 0;
    const deps = buildMockDeps({
      executeSandboxCommand: vi.fn().mockImplementation(() => {
        callCount++;
        // First call: gateway down (verify). Second call: gateway up (re-verify).
        return { status: 0, stdout: callCount <= 1 ? "000" : "200" };
      }),
    });
    const result = recoverDashboardChain("my-sandbox", chain, deps);
    expect(result.attempted).toBe(true);
    expect(deps.restartGateway).toHaveBeenCalled();
    expect(result.actions).toContain("restarted gateway");
  });

  it("re-establishes forward when forward is missing", () => {
    let callCount = 0;
    const deps = buildMockDeps({
      captureForwardList: vi.fn().mockImplementation(() => {
        callCount++;
        // First call: missing. Second call: present.
        return callCount <= 1 ? null : "my-sandbox  127.0.0.1  18789  12345  running";
      }),
    });
    const result = recoverDashboardChain("my-sandbox", chain, deps);
    expect(result.attempted).toBe(true);
    expect(deps.stopForward).toHaveBeenCalled();
    expect(deps.startForward).toHaveBeenCalled();
    expect(result.actions).toContain("re-established forward");
  });

  it("fixes both gateway and forward in order", () => {
    let execCount = 0;
    let fwdCount = 0;
    const deps = buildMockDeps({
      executeSandboxCommand: vi.fn().mockImplementation(() => {
        execCount++;
        return { status: 0, stdout: execCount <= 1 ? "000" : "200" };
      }),
      captureForwardList: vi.fn().mockImplementation(() => {
        fwdCount++;
        return fwdCount <= 1 ? null : "my-sandbox  127.0.0.1  18789  12345  running";
      }),
    });
    const result = recoverDashboardChain("my-sandbox", chain, deps);
    expect(result.attempted).toBe(true);
    expect(result.actions.length).toBe(2);
    expect(result.actions[0]).toBe("restarted gateway");
    expect(result.actions[1]).toBe("re-established forward");
  });

  it("diagnoses CORS mismatch without auto-fixing", () => {
    const deps = buildMockDeps({
      downloadSandboxConfig: vi.fn().mockReturnValue({
        gateway: { controlUi: { allowedOrigins: ["http://wrong-host:18789"] } },
      }),
    });
    const result = recoverDashboardChain("my-sandbox", chain, deps);
    expect(result.attempted).toBe(true);
    expect(result.actions.some((a) => a.includes("CORS"))).toBe(true);
    // CORS is diagnose-only — no automated fix
  });

  it("reports failure when gateway restart fails", () => {
    const deps = buildMockDeps({
      executeSandboxCommand: vi.fn().mockReturnValue({ status: 0, stdout: "000" }),
      restartGateway: vi.fn().mockReturnValue(false),
    });
    const result = recoverDashboardChain("my-sandbox", chain, deps);
    expect(result.attempted).toBe(true);
    expect(result.after).not.toBeNull();
    expect(result.after!.healthy).toBe(false);
  });

  it("is idempotent — second call on healthy chain is no-op", () => {
    const deps = buildMockDeps();
    const result1 = recoverDashboardChain("my-sandbox", chain, deps);
    const result2 = recoverDashboardChain("my-sandbox", chain, deps);
    expect(result1.attempted).toBe(false);
    expect(result2.attempted).toBe(false);
  });
});
