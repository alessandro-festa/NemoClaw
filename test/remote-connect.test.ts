// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import * as http from "node:http";
import {
  fetchConnectIntent,
  openConnectTunnel,
  ConnectIntentError,
  type ConnectIntentResponse,
} from "../src/lib/remote-connect";

// Hoist the SSRF mock at module level so it intercepts the dynamic import
// inside remote-connect.ts regardless of test-suite execution order.
const mockValidateEndpointUrl = vi.fn<(url: string) => Promise<{ url: string; pinnedUrl: string }>>();
vi.mock("../nemoclaw/dist/blueprint/ssrf.js", () => ({
  validateEndpointUrl: mockValidateEndpointUrl,
}));

const validTicket: ConnectIntentResponse = {
  sandboxName: "sandbox-alice",
  namespace: "deploy1-eng",
  status: "ready",
  gatewayURL: "http://aif-stack-deploy1-group-eng.deploy1-eng.svc.cluster.local:8080",
  scaledAt: "2026-04-28T12:00:00Z",
  sandboxID: "sandbox-alice",
  connectToken: "test-token-abc",
  gatewayHost: "127.0.0.1",
  gatewayPort: 0, // overridden per-test to the httptest server's port
  gatewayScheme: "http",
  connectPath: "/connect/ssh",
};

// ── fetchConnectIntent ──────────────────────────────────────────────────────

describe("fetchConnectIntent", () => {
  beforeEach(() => {
    mockValidateEndpointUrl.mockReset();
    vi.unstubAllGlobals();
    mockValidateEndpointUrl.mockResolvedValue({
      url: "https://aif.example.com",
      pinnedUrl: "https://aif.example.com",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a parsed ticket on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => validTicket,
      }),
    );

    const got = await fetchConnectIntent("https://aif.example.com", "good-key");
    expect(got).toEqual(validTicket);
  });

  it("includes the api key in the Authorization header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => validTicket,
    });
    vi.stubGlobal("fetch", fetchSpy);

    await fetchConnectIntent("https://aif.example.com", "secret-key");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-key");
  });

  it("sends sandboxName when provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => validTicket,
    });
    vi.stubGlobal("fetch", fetchSpy);

    await fetchConnectIntent("https://aif.example.com", "k", "sandbox-alice");
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ sandboxName: "sandbox-alice" });
  });

  it("throws ConnectIntentError with the operator's structured envelope on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 504,
        statusText: "Gateway Timeout",
        json: async () => ({
          error: 'sandbox "sandbox-alice" did not become Ready within 60s',
          sandboxName: "sandbox-alice",
          namespace: "deploy1-eng",
          timeout: "60s",
        }),
      }),
    );

    const err = await fetchConnectIntent("https://aif.example.com", "k").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectIntentError);
    expect((err as ConnectIntentError).status).toBe(504);
    expect((err as Error).message).toContain('sandbox "sandbox-alice" did not become Ready within 60s');
  });

  it("rejects a malformed (schema-incompatible) success payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ status: "ready" }), // missing all the other fields
      }),
    );

    await expect(fetchConnectIntent("https://aif.example.com", "k")).rejects.toThrow(
      "Connect-intent response does not match expected schema",
    );
  });
});

// ── openConnectTunnel ───────────────────────────────────────────────────────

describe("openConnectTunnel", () => {
  let server: http.Server;
  let port: number;
  let lastSeenHeaders: Record<string, string | string[] | undefined>;

  beforeEach(async () => {
    lastSeenHeaders = {};
    server = http.createServer();
    // CONNECT requests reach the 'connect' event with the upgraded socket.
    server.on("connect", (req, socket) => {
      lastSeenHeaders = req.headers;
      const sandboxID = req.headers["x-sandbox-id"];
      const token = req.headers["x-sandbox-token"];
      if (!sandboxID || !token) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      if (token !== "test-token-abc") {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      // Acknowledge the upgrade. We deliberately do NOT echo or keep the
      // socket open — the test verifies the upgrade succeeded, then closes.
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    // closeAllConnections + unref + close-without-wait. We deliberately
    // don't await server.close() — it can hang indefinitely on Node 22+
    // when a CONNECT-upgraded socket has been handed off (the http server
    // no longer "owns" the socket, but its internal connection counter
    // doesn't always drop to 0). unref() lets the test process exit
    // cleanly even if the server holds residual references.
    server.closeAllConnections();
    server.close();
    server.unref();
  });

  it("returns the upgraded socket on a 200 response", async () => {
    const ticket = { ...validTicket, gatewayPort: port };
    const socket = await openConnectTunnel(ticket);
    expect(socket).toBeDefined();
    expect(socket.writable).toBe(true);
    socket.destroy();
  });

  it("forwards x-sandbox-id and x-sandbox-token headers", async () => {
    const ticket = { ...validTicket, gatewayPort: port };
    const socket = await openConnectTunnel(ticket);
    socket.destroy();
    expect(lastSeenHeaders["x-sandbox-id"]).toBe("sandbox-alice");
    expect(lastSeenHeaders["x-sandbox-token"]).toBe("test-token-abc");
  });

  it("rejects when the gateway returns 401", async () => {
    const ticket = { ...validTicket, gatewayPort: port, connectToken: "wrong-token" };
    await expect(openConnectTunnel(ticket)).rejects.toThrow(/401/);
  });

  it("rejects when the gateway is unreachable", async () => {
    // Close the server first so 127.0.0.1:<port> is dead.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const ticket = { ...validTicket, gatewayPort: port };
    await expect(openConnectTunnel(ticket)).rejects.toThrow(/gateway tunnel/);
    // Re-open so afterEach's close() doesn't reject — afterEach handles a
    // closed server gracefully via close(callback).
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
});

// ── No kubectl invariant ────────────────────────────────────────────────────

describe("connect path", () => {
  it("does not invoke kubectl from remote-connect.ts (static check)", () => {
    // Failing this assertion means a kubectl spawn leaked back into the
    // no-kubectl path (US-505 / US-506). We grep for actual invocations
    // (spawnSync/exec/execFile with kubectl), not the literal word — the
    // file's docstrings mention kubectl in prose.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "remote-connect.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/spawnSync\s*\(\s*["']kubectl/);
    expect(src).not.toMatch(/exec(?:File|Sync)?\s*\(\s*["']kubectl/);
    expect(src).not.toMatch(/require\(\s*["']kubectl/);
  });
});
