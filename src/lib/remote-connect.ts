// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { Client as SSHClient, type ClientChannel } from "ssh2";

// First-pull of multi-hundred-MB sandbox images on a cold node can run
// 60-180s. The aif-nc operator's --scale-up-timeout default is 5 min, so
// match that and add a small margin so the client doesn't bail out before
// the operator does. Override with NEMOCLAW_CONNECT_INTENT_TIMEOUT_MS for
// even-longer / shorter waits.
const DEFAULT_FETCH_TIMEOUT_MS = 6 * 60 * 1000;
const FETCH_TIMEOUT_MS = (() => {
  const raw = process.env.NEMOCLAW_CONNECT_INTENT_TIMEOUT_MS;
  if (!raw) return DEFAULT_FETCH_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FETCH_TIMEOUT_MS;
})();
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * The shape of POST /v1/connect-intent's response from the aif-nc operator.
 * Mirrors `internal/apiserver/connect_intent.go` ConnectIntentResponse.
 */
export interface ConnectIntentResponse {
  sandboxName: string;
  namespace: string;
  status: string;
  gatewayURL: string;
  scaledAt: string;
  sandboxID: string;
  connectToken: string;
  gatewayHost: string;
  gatewayPort: number;
  gatewayScheme: string;
  connectPath: string;
  hostKeyFingerprint?: string;
  expiresAtMs?: number;
  /**
   * Per-sandbox OpenClaw Web UI URL with the token already substituted.
   * Optional — operator omits when token isn't published yet (sandbox
   * hasn't run `openclaw onboard` yet, or webui-token-publisher sidecar
   * still polling). claude#87.
   */
  webUIUrl?: string;
}

function isConnectIntentResponse(obj: unknown): obj is ConnectIntentResponse {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.sandboxName === "string" &&
    typeof r.namespace === "string" &&
    typeof r.status === "string" &&
    typeof r.gatewayURL === "string" &&
    typeof r.sandboxID === "string" &&
    typeof r.connectToken === "string" &&
    typeof r.gatewayHost === "string" &&
    typeof r.gatewayPort === "number" &&
    typeof r.gatewayScheme === "string" &&
    typeof r.connectPath === "string"
  );
}

/**
 * Resolve the nemoclaw SSRF validator lazily. Mirrors the pattern in
 * remote-config-fetch.ts so the CLI doesn't carry a hard compile-time
 * cross-package import.
 */
async function resolveSSRFValidator(): Promise<
  (
    url: string,
    options?: { allowPrivate?: boolean },
  ) => Promise<{ url: string; pinnedUrl: string }>
> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // @ts-ignore
  const mod = await import("../../nemoclaw/dist/blueprint/ssrf.js");
  return (
    mod as {
      validateEndpointUrl: (
        url: string,
        options?: { allowPrivate?: boolean },
      ) => Promise<{ url: string; pinnedUrl: string }>;
    }
  ).validateEndpointUrl;
}

/**
 * Call POST /v1/connect-intent on the aif-nc operator. The operator scales
 * the per-user sandbox 0→1, waits for it to become Ready, mints an SSH
 * session token via the gateway gRPC, and returns everything we need to open
 * the HTTP CONNECT tunnel.
 *
 * Reuses the same SSRF validation pattern as fetchRemoteConfig — the
 * NEMOCLAW_ALLOW_PRIVATE_SERVER=1 escape hatch works the same way.
 */
export async function fetchConnectIntent(
  serverUrl: string,
  apiKey: string,
  sandboxName?: string,
): Promise<ConnectIntentResponse> {
  const validateEndpointUrl = await resolveSSRFValidator();
  const allowPrivate = process.env.NEMOCLAW_ALLOW_PRIVATE_SERVER === "1";
  await validateEndpointUrl(serverUrl, { allowPrivate });

  const base = serverUrl.replace(/\/$/, "");
  const url = `${base}/v1/connect-intent`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(sandboxName ? { sandboxName } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Failed to reach operator at ${serverUrl}: ${String(err)}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`Operator returned non-JSON response: ${String(err)}`);
  }

  if (!response.ok) {
    // Surface the operator's structured error envelope so callers can
    // distinguish 504 (scale-up timeout) from 502 (gateway down) etc.
    const errMsg = (body as { error?: string })?.error || `${response.status} ${response.statusText}`;
    throw new ConnectIntentError(response.status, errMsg, body);
  }

  if (!isConnectIntentResponse(body)) {
    throw new Error(
      "Connect-intent response does not match expected schema. " +
        "Ensure the operator is running aif-nc with US-505 token-minting support.",
    );
  }
  return body;
}

/**
 * Shape of POST /v1/disconnect-intent's response. Mirrors
 * `internal/apiserver/disconnect_intent.go` DisconnectIntentResponse.
 */
export interface DisconnectIntentResponse {
  sandboxName: string;
  namespace: string;
  status: string;
  scaledAt: string;
  replicas: number;
}

function isDisconnectIntentResponse(obj: unknown): obj is DisconnectIntentResponse {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.sandboxName === "string" &&
    typeof r.namespace === "string" &&
    typeof r.status === "string" &&
    typeof r.replicas === "number"
  );
}

/**
 * Call POST /v1/disconnect-intent on the aif-nc operator. Patches the
 * per-user Sandbox CR's spec.replicas back to 0 — the same lazy-off
 * mechanism the idle scale-down loop uses, but user-triggered. PVC and
 * ApiKey are intentionally NOT touched so reconnect picks up the same
 * workspace + creds.
 *
 * Same auth + SSRF validation as fetchConnectIntent.
 */
export async function fetchDisconnectIntent(
  serverUrl: string,
  apiKey: string,
  sandboxName?: string,
): Promise<DisconnectIntentResponse> {
  const validateEndpointUrl = await resolveSSRFValidator();
  const allowPrivate = process.env.NEMOCLAW_ALLOW_PRIVATE_SERVER === "1";
  await validateEndpointUrl(serverUrl, { allowPrivate });

  const base = serverUrl.replace(/\/$/, "");
  const url = `${base}/v1/disconnect-intent`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(sandboxName ? { sandboxName } : {}),
      // Disconnect is fast (just patches the CR); 30s is plenty even
      // accounting for a slow apiserver.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Failed to reach operator at ${serverUrl}: ${String(err)}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`Operator returned non-JSON response: ${String(err)}`);
  }

  if (!response.ok) {
    const errMsg = (body as { error?: string })?.error || `${response.status} ${response.statusText}`;
    throw new ConnectIntentError(response.status, errMsg, body);
  }

  if (!isDisconnectIntentResponse(body)) {
    throw new Error("Disconnect-intent response does not match expected schema.");
  }
  return body;
}

export class ConnectIntentError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(`POST /v1/connect-intent → ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Open an HTTP CONNECT tunnel to the OpenShell gateway and return the upgraded
 * raw socket. The gateway accepts the upgrade only when both `x-sandbox-id`
 * and `x-sandbox-token` headers are present and match a registered SshSession
 * (see OpenShell/crates/openshell-server/src/ssh_tunnel.rs:20-21).
 */
export function openConnectTunnel(ticket: ConnectIntentResponse): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // Allow operators / dev environments to override the gateway endpoint —
    // useful when the operator-advertised address (typically a NodePort on
    // the cluster's node IP) isn't reachable from the laptop. Common case:
    // lima/k3s on macOS, where NodePorts aren't bridged. Pair with a
    // `kubectl port-forward svc/<gateway> <local>:<remote>` to make the
    // override target a real listener.
    //
    //   NEMOCLAW_GATEWAY_HOST_OVERRIDE=127.0.0.1
    //   NEMOCLAW_GATEWAY_PORT_OVERRIDE=30051
    //   NEMOCLAW_GATEWAY_SCHEME_OVERRIDE=http   # optional
    //
    // Production users should leave these unset and let the operator's
    // gatewayHost/Port (parsed from Status.GatewayURLs server-side) drive.
    const overrideHost = process.env.NEMOCLAW_GATEWAY_HOST_OVERRIDE;
    const overridePort = process.env.NEMOCLAW_GATEWAY_PORT_OVERRIDE;
    const overrideScheme = process.env.NEMOCLAW_GATEWAY_SCHEME_OVERRIDE;
    const effectiveHost = overrideHost || ticket.gatewayHost;
    const effectivePort = overridePort ? Number(overridePort) : ticket.gatewayPort;
    const effectiveScheme = overrideScheme || ticket.gatewayScheme;
    if (overrideHost || overridePort || overrideScheme) {
      console.error(
        `  ⚠ Using gateway override ${effectiveScheme}://${effectiveHost}:${effectivePort} ` +
          `(operator advertised ${ticket.gatewayScheme}://${ticket.gatewayHost}:${ticket.gatewayPort}). ` +
          `Unset NEMOCLAW_GATEWAY_HOST_OVERRIDE / _PORT_OVERRIDE / _SCHEME_OVERRIDE for production.`,
      );
    }

    const isHttps = effectiveScheme === "https";
    const requestModule = isHttps ? https : http;

    const reqOpts: http.RequestOptions | https.RequestOptions = {
      host: effectiveHost,
      port: effectivePort,
      method: "CONNECT",
      // The CONNECT path is the gateway's HTTP CONNECT endpoint. RFC 7231
      // §4.3.6 says CONNECT's request-target is authority-form, but the
      // OpenShell gateway uses path-form (`/connect/ssh`) and looks at the
      // headers for the actual target.
      path: ticket.connectPath,
      headers: {
        // Send the operator-advertised Host header even when the actual
        // socket goes elsewhere — the gateway uses this for routing/logging.
        Host: `${ticket.gatewayHost}:${ticket.gatewayPort}`,
        "x-sandbox-id": ticket.sandboxID,
        "x-sandbox-token": ticket.connectToken,
      },
      timeout: CONNECT_TIMEOUT_MS,
    };
    if (isHttps) {
      // Disable cert validation only when the user explicitly asked for it.
      // In production the gateway terminates TLS at a real ingress.
      (reqOpts as https.RequestOptions).rejectUnauthorized =
        process.env.NEMOCLAW_INSECURE_GATEWAY !== "1";
    }

    const req = requestModule.request(reqOpts);
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(
          new Error(
            `gateway HTTP CONNECT failed: ${res.statusCode} ${res.statusMessage || ""}`.trim(),
          ),
        );
        return;
      }
      resolve(socket);
    });
    req.on("error", (err) => reject(new Error(`gateway tunnel: ${err.message}`)));
    req.on("timeout", () => {
      req.destroy(new Error(`gateway HTTP CONNECT timed out after ${CONNECT_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

/**
 * Layer SSH over the upgraded socket and hand the user an interactive shell.
 * Resolves to the SSH exit status once the shell exits.
 *
 * Auth: the sandbox sshd accepts any user (auth_none → Accept, see
 * OpenShell/crates/openshell-sandbox/src/ssh.rs). We pass `username: "root"`
 * because ssh2 requires a username string but the value is irrelevant.
 *
 * stdio handoff: stdin → SSH stream, SSH stream → stdout/stderr. We forward
 * SIGWINCH so terminal resize works inside the sandbox shell.
 */
export function runInteractiveShell(socket: net.Socket | tls.TLSSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();

    const cleanup = (exitCode: number) => {
      try {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.unref();
      } catch {
        // Best-effort terminal teardown; ignore errors.
      }
      client.end();
      resolve(exitCode);
    };

    client.on("ready", () => {
      // ssh2's client.shell(window, callback): pass a window descriptor
      // (not wrapped in `{ pty: … }`) for a PTY-allocated shell, or `false`
      // for no PTY (when stdout isn't a TTY, e.g. piped to less).
      if (process.stdout.isTTY) {
        const window = {
          term: process.env.TERM || "xterm-256color",
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
          width: 0,
          height: 0,
        };
        client.shell(window, (err, stream) => {
          if (err) {
            client.end();
            reject(new Error(`ssh shell failed: ${err.message}`));
            return;
          }
          wireShellStdio(stream, cleanup);
        });
      } else {
        client.shell(false, (err, stream) => {
          if (err) {
            client.end();
            reject(new Error(`ssh shell failed: ${err.message}`));
            return;
          }
          wireShellStdio(stream, cleanup);
        });
      }
    });

    client.on("error", (err) => {
      client.end();
      reject(new Error(`ssh client error: ${err.message}`));
    });

    client.connect({
      sock: socket,
      username: "root",
      tryKeyboard: false,
      // Accept any host key — the sandbox sshd uses an ephemeral key. The
      // outer transport (HTTP CONNECT) is what we actually trust here.
      hostHash: "sha256",
      hostVerifier: () => true,
    });
  });
}

function wireShellStdio(stream: ClientChannel, cleanup: (code: number) => void) {
  // Pipe SSH stream → stdout/stderr.
  stream.pipe(process.stdout);
  if (typeof (stream as { stderr?: NodeJS.ReadableStream }).stderr?.pipe === "function") {
    (stream as { stderr: NodeJS.ReadableStream }).stderr.pipe(process.stderr);
  }

  // stdin → SSH stream.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.pipe(stream);

  // Window resize.
  const onResize = () => {
    if (process.stdout.isTTY) {
      stream.setWindow(process.stdout.rows || 24, process.stdout.columns || 80, 0, 0);
    }
  };
  process.stdout.on("resize", onResize);

  let exitCode = 0;
  stream.on("exit", (code: number | null) => {
    exitCode = code ?? 0;
  });
  stream.on("close", () => {
    process.stdout.off("resize", onResize);
    cleanup(exitCode);
  });
}

/**
 * High-level entry point: fetch a connect-intent ticket from the operator,
 * open the HTTP CONNECT tunnel, run an interactive SSH shell. The user's
 * laptop never needs kubectl or a kubeconfig — only the NemoClaw binary.
 */
export async function connectToRemoteSandbox(opts: {
  serverUrl: string;
  apiKey: string;
  sandboxName?: string;
}): Promise<number> {
  const ticket = await fetchConnectIntent(opts.serverUrl, opts.apiKey, opts.sandboxName);
  // Print the OpenClaw Web UI URL when the operator has substituted the
  // real token (claude#87, aif-nc PR-C). Operator omits this field when the
  // sandbox hasn't onboarded yet; in that case nothing prints. Goes to
  // stderr so it doesn't pollute stdout if the user pipes the SSH session.
  if (ticket.webUIUrl) {
    process.stderr.write(`Web UI: ${ticket.webUIUrl}\n`);
  }
  const socket = await openConnectTunnel(ticket);
  return runInteractiveShell(socket);
}
