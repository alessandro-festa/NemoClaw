// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  buildChain,
  buildAuthenticatedDashboardUrl,
  buildControlUiUrls,
  getDashboardAccessInfo,
  getDashboardGuidanceLines,
} from "../../dist/lib/dashboard-contract";

describe("buildChain", () => {
  it("returns default loopback chain when called with no arguments", () => {
    const chain = buildChain();
    expect(chain.accessUrl).toBe("http://127.0.0.1:18789");
    expect(chain.corsOrigins).toEqual(["http://127.0.0.1:18789"]);
    expect(chain.forwardTarget).toBe("18789");
    expect(chain.healthEndpoint).toBe("/health");
    expect(chain.port).toBe(18789);
    expect(chain.bindAddress).toBe("127.0.0.1");
  });

  it("returns port-only forward for explicit loopback URL", () => {
    const chain = buildChain({ chatUiUrl: "http://127.0.0.1:18789" });
    expect(chain.forwardTarget).toBe("18789");
    expect(chain.bindAddress).toBe("127.0.0.1");
  });

  it("preserves custom port from loopback URL", () => {
    const chain = buildChain({ chatUiUrl: "http://127.0.0.1:19000" });
    expect(chain.port).toBe(19000);
    expect(chain.forwardTarget).toBe("19000");
    expect(chain.accessUrl).toContain(":19000");
  });

  it("binds to 0.0.0.0 for non-loopback URL", () => {
    const chain = buildChain({ chatUiUrl: "https://my-brev-host.example.com:18789" });
    expect(chain.forwardTarget).toBe("0.0.0.0:18789");
    expect(chain.bindAddress).toBe("0.0.0.0");
    expect(chain.corsOrigins).toContain("http://127.0.0.1:18789");
    expect(chain.corsOrigins).toContain("https://my-brev-host.example.com:18789");
  });

  it("binds to 0.0.0.0 for private IP URL", () => {
    const chain = buildChain({ chatUiUrl: "http://10.0.0.25:18789" });
    expect(chain.forwardTarget).toBe("0.0.0.0:18789");
    expect(chain.corsOrigins).toContain("http://10.0.0.25:18789");
    expect(chain.corsOrigins).toContain("http://127.0.0.1:18789");
  });

  it("uses WSL host address and binds to 0.0.0.0 when WSL detected", () => {
    const chain = buildChain({ isWsl: true, wslHostAddress: "172.24.240.1" });
    expect(chain.forwardTarget).toBe("0.0.0.0:18789");
    expect(chain.accessUrl).toBe("http://172.24.240.1:18789");
    expect(chain.corsOrigins).toContain("http://172.24.240.1:18789");
    expect(chain.corsOrigins).toContain("http://127.0.0.1:18789");
  });

  it("uses custom port on WSL", () => {
    const chain = buildChain({
      isWsl: true,
      wslHostAddress: "172.24.240.1",
      chatUiUrl: "http://127.0.0.1:19999",
    });
    expect(chain.port).toBe(19999);
    expect(chain.forwardTarget).toBe("0.0.0.0:19999");
  });

  it("respects explicit port override", () => {
    const chain = buildChain({ port: 19000 });
    expect(chain.port).toBe(19000);
    expect(chain.accessUrl).toContain(":19000");
  });

  it("treats empty chatUiUrl as default", () => {
    const chain = buildChain({ chatUiUrl: "" });
    expect(chain.port).toBe(18789);
    expect(chain.forwardTarget).toBe("18789");
  });

  it("gracefully falls back for invalid URL", () => {
    const chain = buildChain({ chatUiUrl: "not-a-url" });
    expect(chain.port).toBe(18789);
    // Should not throw
  });

  it("always sets healthEndpoint to /health", () => {
    expect(buildChain().healthEndpoint).toBe("/health");
    expect(buildChain({ chatUiUrl: "https://example.com:18789" }).healthEndpoint).toBe("/health");
    expect(buildChain({ isWsl: true }).healthEndpoint).toBe("/health");
  });

  it("deduplicates CORS origins", () => {
    const chain = buildChain({ chatUiUrl: "http://127.0.0.1:18789" });
    expect(chain.corsOrigins).toHaveLength(1);
  });

  it("always includes loopback as first CORS origin", () => {
    const chain = buildChain({ chatUiUrl: "https://my-brev-host.example.com:18789" });
    expect(chain.corsOrigins[0]).toBe("http://127.0.0.1:18789");
  });

  it("returns port-only forward for IPv6 loopback", () => {
    const chain = buildChain({ chatUiUrl: "http://[::1]:18789" });
    expect(chain.forwardTarget).toBe("18789");
  });

  it("returns port-only forward for localhost hostname", () => {
    const chain = buildChain({ chatUiUrl: "http://localhost:18789" });
    expect(chain.forwardTarget).toBe("18789");
  });
});

describe("getDashboardAccessInfo", () => {
  it("returns single URL with token hash for loopback chain", () => {
    const chain = buildChain();
    const access = getDashboardAccessInfo(chain, "my-token");
    expect(access).toEqual([
      { label: "Dashboard", url: "http://127.0.0.1:18789/#token=my-token" },
    ]);
  });

  it("includes both loopback and access URLs for non-loopback chain", () => {
    const chain = buildChain({ chatUiUrl: "https://my-brev-host.example.com:18789" });
    const access = getDashboardAccessInfo(chain, "tok");
    expect(access.length).toBeGreaterThanOrEqual(2);
    expect(access[0].label).toBe("Dashboard");
    expect(access[1].url).toContain("my-brev-host.example.com");
  });

  it("includes VS Code/WSL URL when wslHostAddress provided", () => {
    const chain = buildChain({ isWsl: true, wslHostAddress: "172.24.240.1", chatUiUrl: "http://127.0.0.1:19999" });
    const access = getDashboardAccessInfo(chain, "secret-token", { wslHostAddress: "172.24.240.1" });
    const wslEntry = access.find((a) => a.label === "VS Code/WSL");
    expect(wslEntry).toBeDefined();
    expect(wslEntry!.url).toContain("172.24.240.1:19999");
  });

  it("returns URLs without hash when token is null", () => {
    const chain = buildChain();
    const access = getDashboardAccessInfo(chain, null);
    expect(access[0].url).not.toContain("#token=");
  });

  it("deduplicates when access URL matches loopback", () => {
    const chain = buildChain();
    const access = getDashboardAccessInfo(chain, "tok");
    expect(access).toHaveLength(1);
  });
});

describe("getDashboardGuidanceLines", () => {
  it("returns port forwarding hint with correct port", () => {
    const chain = buildChain();
    const guidance = getDashboardGuidanceLines(chain, []);
    expect(guidance.some((g) => g.includes("18789"))).toBe(true);
  });

  it("includes WSL-specific hint when WSL detected", () => {
    const chain = buildChain({ isWsl: true });
    const guidance = getDashboardGuidanceLines(chain, [], { isWsl: true });
    expect(guidance.some((g) => g.includes("WSL"))).toBe(true);
  });

  it("includes note when no URLs generated", () => {
    const chain = buildChain();
    const guidance = getDashboardGuidanceLines(chain, []);
    expect(guidance.some((g) => g.includes("No dashboard URLs") || g.includes("forwarded"))).toBe(true);
  });
});

describe("buildControlUiUrls", () => {
  it("builds URL with token hash", () => {
    const urls = buildControlUiUrls("my-token");
    expect(urls).toEqual(["http://127.0.0.1:18789/#token=my-token"]);
  });

  it("builds URL without token", () => {
    const urls = buildControlUiUrls(null);
    expect(urls).toEqual(["http://127.0.0.1:18789/"]);
  });

  it("includes chatUiUrl when passed as non-loopback http URL", () => {
    const urls = buildControlUiUrls("tok", 18789, "https://my-dashboard.example.com");
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe("https://my-dashboard.example.com/#token=tok");
  });

  it("deduplicates when chatUiUrl matches local", () => {
    const urls = buildControlUiUrls(null, 18789, "http://127.0.0.1:18789");
    expect(urls).toHaveLength(1);
  });

  it("ignores non-http chatUiUrl", () => {
    const urls = buildControlUiUrls("tok", 18789, "ftp://example.com");
    expect(urls).toHaveLength(1);
  });

  it("ignores empty chatUiUrl", () => {
    const urls = buildControlUiUrls("tok", 18789, "  ");
    expect(urls).toHaveLength(1);
  });

  it("uses configured port in displayed URL", () => {
    const urls = buildControlUiUrls("my-token", 19000);
    expect(urls).toEqual(["http://127.0.0.1:19000/#token=my-token"]);
  });
});

describe("buildAuthenticatedDashboardUrl", () => {
  it("appends token hash to URL", () => {
    expect(buildAuthenticatedDashboardUrl("http://127.0.0.1:18789/", "tok")).toBe(
      "http://127.0.0.1:18789/#token=tok",
    );
  });

  it("returns base URL when token is null", () => {
    expect(buildAuthenticatedDashboardUrl("http://127.0.0.1:18789/", null)).toBe(
      "http://127.0.0.1:18789/",
    );
  });
});
