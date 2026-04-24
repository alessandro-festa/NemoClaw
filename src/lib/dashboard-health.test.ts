// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { verifyDashboardChain } from "../../dist/lib/dashboard-health";
import { buildChain } from "../../dist/lib/dashboard-contract";

function buildMockDeps(overrides = {}) {
  return {
    executeSandboxCommand: () => ({ status: 0, stdout: "200" }),
    captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
    downloadSandboxConfig: () => ({
      gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } },
    }),
    ...overrides,
  };
}

describe("verifyDashboardChain", () => {
  const chain = buildChain();

  it("reports healthy when all links ok", () => {
    const result = verifyDashboardChain("my-sandbox", chain, buildMockDeps());
    expect(result.healthy).toBe(true);
    expect(result.links.gateway.ok).toBe(true);
    expect(result.links.forward.ok).toBe(true);
    expect(result.links.cors.ok).toBe(true);
  });

  it("reports gateway down when curl returns 000", () => {
    const deps = buildMockDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000" }),
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.links.gateway.ok).toBe(false);
    expect(result.links.gateway.detail).toContain("000");
  });

  it("reports gateway alive when curl returns 401", () => {
    const deps = buildMockDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "401" }),
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.healthy).toBe(true);
    expect(result.links.gateway.ok).toBe(true);
  });

  it("reports gateway alive when curl returns 200", () => {
    const deps = buildMockDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "200" }),
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.links.gateway.ok).toBe(true);
  });

  it("reports gateway unknown when executeSandboxCommand returns null", () => {
    const deps = buildMockDeps({
      executeSandboxCommand: () => null,
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.links.gateway.ok).toBe(false);
  });

  it("reports forward missing when no matching row", () => {
    const deps = buildMockDeps({
      captureForwardList: () => "other-sandbox  127.0.0.1  19999  54321  running",
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.links.forward.ok).toBe(false);
  });

  it("reports forward ok when matching sandbox and port found", () => {
    const deps = buildMockDeps({
      captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.links.forward.ok).toBe(true);
    expect(result.links.forward.detail).toContain("12345");
  });

  it("reports forward conflict when port owned by different sandbox", () => {
    const deps = buildMockDeps({
      captureForwardList: () => "other-sandbox  127.0.0.1  18789  12345  running",
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.links.forward.ok).toBe(false);
    expect(result.links.forward.detail).toContain("other-sandbox");
  });

  it("reports forward missing when captureForwardList returns null", () => {
    const deps = buildMockDeps({
      captureForwardList: () => null,
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.links.forward.ok).toBe(false);
  });

  it("reports CORS ok when access URL origin in allowedOrigins", () => {
    const result = verifyDashboardChain("my-sandbox", chain, buildMockDeps());
    expect(result.links.cors.ok).toBe(true);
  });

  it("reports CORS missing when access URL origin not in allowedOrigins", () => {
    const deps = buildMockDeps({
      downloadSandboxConfig: () => ({
        gateway: { controlUi: { allowedOrigins: ["http://some-other-host:18789"] } },
      }),
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.links.cors.ok).toBe(false);
  });

  it("reports CORS failed when config download returns null", () => {
    const deps = buildMockDeps({
      downloadSandboxConfig: () => null,
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.links.cors.ok).toBe(false);
  });

  it("concatenates all failures in diagnosis when multiple links down", () => {
    const deps = buildMockDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000" }),
      captureForwardList: () => null,
      downloadSandboxConfig: () => null,
    });
    const result = verifyDashboardChain("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.diagnosis.length).toBeGreaterThan(0);
    // Should mention all 3 failures
    expect(result.links.gateway.ok).toBe(false);
    expect(result.links.forward.ok).toBe(false);
    expect(result.links.cors.ok).toBe(false);
  });
});
