// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isRemoteConfig } from "../src/lib/remote-config";
import { extractRemoteOnboardArgs } from "../src/lib/onboard-command";

// Hoist the SSRF mock at module level so it intercepts the dynamic import
// inside remote-config-fetch.ts regardless of test-suite execution order.
const mockValidateEndpointUrl = vi.fn<[string], Promise<{ url: string; pinnedUrl: string }>>();
vi.mock("../nemoclaw/dist/blueprint/ssrf.js", () => ({
  validateEndpointUrl: mockValidateEndpointUrl,
}));

// ── isRemoteConfig ──────────────────────────────────────────────────────────

describe("isRemoteConfig", () => {
  const validPayload = {
    version: "1",
    blueprintId: "suse-ai-factory",
    blueprintVersion: "0.1.0",
    isolationMode: "Shared" as const,
    inferenceEndpoint: "https://inference.example.com/v1",
    inferenceProviderType: "nvidia" as const,
    inferenceModel: "meta/llama-3.1-8b-instruct",
    gatewayEndpoint: "https://gateway.example.com",
    sandboxImage: "nvcr.io/nvidia/nemoclaw/sandbox:latest",
  };

  it("accepts a fully-valid payload", () => {
    expect(isRemoteConfig(validPayload)).toBe(true);
  });

  it("accepts a payload with optional policyBundleRef", () => {
    expect(
      isRemoteConfig({ ...validPayload, policyBundleRef: "/etc/bundles/policy.tar.gz" }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isRemoteConfig(null)).toBe(false);
  });

  it("rejects non-objects (string, number, array)", () => {
    expect(isRemoteConfig("string")).toBe(false);
    expect(isRemoteConfig(42)).toBe(false);
    expect(isRemoteConfig([])).toBe(false);
  });

  it("rejects when a required field is missing", () => {
    const { version: _v, ...rest } = validPayload;
    expect(isRemoteConfig(rest)).toBe(false);
  });

  it("rejects an unknown isolationMode value", () => {
    expect(isRemoteConfig({ ...validPayload, isolationMode: "PerUser" })).toBe(false);
  });

  it("rejects an unknown inferenceProviderType value", () => {
    expect(isRemoteConfig({ ...validPayload, inferenceProviderType: "anthropic" })).toBe(false);
  });

  it("rejects required string fields set to wrong types", () => {
    expect(isRemoteConfig({ ...validPayload, blueprintId: 42 })).toBe(false);
    expect(isRemoteConfig({ ...validPayload, sandboxImage: null })).toBe(false);
  });

  it("rejects policyBundleRef set to a non-string truthy value", () => {
    expect(isRemoteConfig({ ...validPayload, policyBundleRef: 123 })).toBe(false);
  });
});

// ── extractRemoteOnboardArgs ────────────────────────────────────────────────

describe("extractRemoteOnboardArgs", () => {
  const noticeFlag = "--yes-i-accept-third-party-software";
  const noop = () => {};
  const throwExit = ((code: number) => {
    throw new Error(`exit:${code}`);
  }) as never;

  it("returns remoteMode=false when neither flag nor env var is set", () => {
    const result = extractRemoteOnboardArgs(["--resume"], {}, { error: noop, exit: throwExit }, noticeFlag);
    expect(result.remoteMode).toBe(false);
    expect(result.apiKey).toBeNull();
    expect(result.serverUrl).toBeNull();
    expect(result.filteredArgs).toEqual(["--resume"]);
  });

  it("reads --api-key and --server-url flags", () => {
    const result = extractRemoteOnboardArgs(
      ["--api-key", "my-key", "--server-url", "https://aif.example.com"],
      {},
      { error: noop, exit: throwExit },
      noticeFlag,
    );
    expect(result.remoteMode).toBe(true);
    expect(result.apiKey).toBe("my-key");
    expect(result.serverUrl).toBe("https://aif.example.com");
    expect(result.filteredArgs).toEqual([]);
  });

  it("reads NEMOCLAW_API_KEY and NEMOCLAW_SERVER_URL env vars", () => {
    const result = extractRemoteOnboardArgs(
      [],
      { NEMOCLAW_API_KEY: "env-key", NEMOCLAW_SERVER_URL: "https://env.example.com" },
      { error: noop, exit: throwExit },
      noticeFlag,
    );
    expect(result.remoteMode).toBe(true);
    expect(result.apiKey).toBe("env-key");
    expect(result.serverUrl).toBe("https://env.example.com");
  });

  it("exits with error when only --api-key is provided", () => {
    const errors: string[] = [];
    expect(() =>
      extractRemoteOnboardArgs(
        ["--api-key", "only-key"],
        {},
        { error: (m = "") => errors.push(m), exit: throwExit },
        noticeFlag,
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--server-url");
  });

  it("exits with error when only --server-url is provided", () => {
    const errors: string[] = [];
    expect(() =>
      extractRemoteOnboardArgs(
        ["--server-url", "https://aif.example.com"],
        {},
        { error: (m = "") => errors.push(m), exit: throwExit },
        noticeFlag,
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--api-key");
  });
});

// ── fetchRemoteConfig ───────────────────────────────────────────────────────

describe("fetchRemoteConfig", () => {
  // Import once — vi.mock above is hoisted and always active.
  let fetchRemoteConfig: (serverUrl: string, apiKey: string) => Promise<unknown>;

  beforeEach(async () => {
    mockValidateEndpointUrl.mockReset();
    vi.unstubAllGlobals();
    // Fresh import each suite run; module is already mocked via vi.mock above.
    ({ fetchRemoteConfig } = await import("../src/lib/remote-config-fetch"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on a private-IP server URL (SSRF rejection)", async () => {
    mockValidateEndpointUrl.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        throw new Error(
          `Endpoint URL resolves to private/internal address ${parsed.hostname}. Connections to internal networks are not allowed.`,
        );
      }
      return { url, pinnedUrl: url };
    });

    await expect(fetchRemoteConfig("http://127.0.0.1:8080", "test-key")).rejects.toThrow(
      "private/internal address",
    );
  });

  it("returns a validated RemoteConfig on a successful response", async () => {
    const remoteConfig = {
      version: "1",
      blueprintId: "suse-ai-factory",
      blueprintVersion: "0.1.0",
      isolationMode: "Shared",
      inferenceEndpoint: "https://inference.example.com/v1",
      inferenceProviderType: "nvidia",
      inferenceModel: "meta/llama-3.1-8b-instruct",
      gatewayEndpoint: "https://gateway.example.com",
      sandboxImage: "nvcr.io/nvidia/nemoclaw/sandbox:latest",
    };

    mockValidateEndpointUrl.mockResolvedValue({ url: "https://aif.example.com", pinnedUrl: "https://aif.example.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => remoteConfig,
      }),
    );

    const result = await fetchRemoteConfig("https://aif.example.com", "valid-key");
    expect(result).toEqual(remoteConfig);
  });

  it("throws a descriptive error on a non-2xx HTTP status", async () => {
    mockValidateEndpointUrl.mockResolvedValue({ url: "https://aif.example.com", pinnedUrl: "https://aif.example.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({}),
      }),
    );

    await expect(fetchRemoteConfig("https://aif.example.com", "bad-key")).rejects.toThrow(
      "HTTP 401 Unauthorized",
    );
  });

  it("throws a descriptive error when the response fails schema validation", async () => {
    mockValidateEndpointUrl.mockResolvedValue({ url: "https://aif.example.com", pinnedUrl: "https://aif.example.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ unexpected: "payload" }),
      }),
    );

    await expect(fetchRemoteConfig("https://aif.example.com", "valid-key")).rejects.toThrow(
      "does not match expected schema",
    );
  });
});
