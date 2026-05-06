// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ORIGINAL_ENV = { ...process.env };
const ONBOARD_MODULE = require.resolve("../dist/lib/onboard.js");

function loadOnboard() {
  delete require.cache[ONBOARD_MODULE];
  return require("../dist/lib/onboard");
}

// Build a probe result matching the shape of CurlProbeResult
// (httpStatus, curlStatus, ok, body, stderr, message). This is the
// real contract the production code reads against.
function probeResult(opts: {
  curlStatus: number;
  httpStatus?: number;
  stderr?: string;
  message?: string;
}) {
  const httpStatus = opts.httpStatus ?? 0;
  return {
    ok: opts.curlStatus === 0 && httpStatus >= 200 && httpStatus < 300,
    httpStatus,
    curlStatus: opts.curlStatus,
    body: "",
    stderr: opts.stderr ?? "",
    message: opts.message ?? "",
  };
}

beforeEach(() => {
  delete process.env.OPENSHELL_GATEWAY_ENDPOINT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete require.cache[ONBOARD_MODULE];
});

describe("connectToRemoteGateway (issue #56)", () => {
  it("sets OPENSHELL_GATEWAY_ENDPOINT when the gateway responds 200", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    const probe = () => probeResult({ curlStatus: 0, httpStatus: 200 });

    await connectToRemoteGateway("http://gw.example.com:30051", probe);

    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("http://gw.example.com:30051");
  });

  it("sets the env even on a 404 (any HTTP status proves reachability)", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    const probe = () => probeResult({ curlStatus: 0, httpStatus: 404 });

    await connectToRemoteGateway("http://gw.example.com:30051", probe);

    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("http://gw.example.com:30051");
  });

  it("throws when curl can't connect (curlStatus !== 0) — DNS NXDOMAIN", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    // curl: (6) Could not resolve host: gateway.aif-system.svc.cluster.local
    const probe = () =>
      probeResult({
        curlStatus: 6,
        stderr: "curl: (6) Could not resolve host: gateway.aif-system.svc.cluster.local",
      });

    await expect(connectToRemoteGateway("http://gw.example.com:30051", probe)).rejects.toThrow(
      "Remote gateway http://gw.example.com:30051 is unreachable",
    );
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
  });

  it("throws on connection refused (curlStatus 7)", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    const probe = () =>
      probeResult({
        curlStatus: 7,
        stderr: "Failed to connect to gw.example.com port 30051: Connection refused",
      });

    await expect(connectToRemoteGateway("http://gw.example.com:30051", probe)).rejects.toThrow(
      "Connection refused",
    );
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
  });

  it("throws on timeout (curlStatus 28) and surfaces the curl error", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    const probe = () =>
      probeResult({
        curlStatus: 28,
        stderr: "curl: (28) Operation timed out after 5000 milliseconds",
      });

    await expect(connectToRemoteGateway("http://gw.example.com:30051", probe)).rejects.toThrow(
      "Operation timed out",
    );
  });

  it("respects OPENSHELL_GATEWAY_ENDPOINT override set in the environment", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "http://localhost:30051";
    let probedUrl: string | undefined;
    const probe = (args: readonly string[]) => {
      probedUrl = args[args.length - 1];
      return probeResult({ curlStatus: 0, httpStatus: 200 });
    };

    await connectToRemoteGateway("http://192.168.64.28:30051", probe);

    // Probe should hit the override URL, not the operator-advertised one.
    expect(probedUrl).toBe("http://localhost:30051");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("http://localhost:30051");
  });

  it("uses the operator-advertised endpoint when no override is present", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    let probedUrl: string | undefined;
    const probe = (args: readonly string[]) => {
      probedUrl = args[args.length - 1];
      return probeResult({ curlStatus: 0, httpStatus: 200 });
    };

    await connectToRemoteGateway("http://192.168.64.28:30051", probe);

    expect(probedUrl).toBe("http://192.168.64.28:30051");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("http://192.168.64.28:30051");
  });

  it("passes the endpoint and 5s timeout through to curl", async () => {
    const { connectToRemoteGateway } = loadOnboard();
    let capturedArgs: readonly string[] | null = null;
    const probe = (args: readonly string[]) => {
      capturedArgs = args;
      return probeResult({ curlStatus: 0, httpStatus: 200 });
    };

    await connectToRemoteGateway("http://gw.example.com:30051", probe);

    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs).toContain("http://gw.example.com:30051");
    expect(capturedArgs).toContain("--max-time");
    expect(capturedArgs).toContain("5");
  });
});
