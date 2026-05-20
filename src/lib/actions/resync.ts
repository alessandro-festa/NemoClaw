// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// `nemoclaw resync` — pushes a local airgapped session's audit log
// (and any pending approval requests, when supervisor support lands)
// to the operator's POST /v1/offline-sessions/{deployment}/resync.
// EPIC #114 US-156. Wire contract: aif-nc/docs/airgapped-bundle-spec.md
// appendix B.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Manifest } from "../bundle/types";
import { summarizeAudit } from "../local/audit";
import { resolveNemoclawLocalDir } from "../state/paths";

const OCSF_FILE_PREFIX = "openshell-ocsf";
const HEADER_BUNDLE_ID = "X-Nemoclaw-Bundle-Id";

export interface ResyncOptions {
  serverUrl: string;
  apiKey: string;
  sessionPath?: string;  // Absolute path to a single session dir.
  sessionId?: string;    // Bare session name (looked up under ~/.nemoclaw/local/).
  all?: boolean;         // Resync every session dir under ~/.nemoclaw/local/.
  dryRun?: boolean;      // Build the payload + print it, don't POST.
}

export interface SessionPayload {
  sessionDir: string;
  deployment: string;
  bundleId: string;
  ndjson: string;
  auditEventCount: number;
}

export interface ResyncResult {
  session: SessionPayload;
  status: "posted" | "dry-run" | "failed";
  httpStatus?: number;
  response?: unknown;
  error?: string;
}

// listLocalSessions enumerates immediate child directories of
// ~/.nemoclaw/local/ that look like a run-local session (have manifest.json
// at the root).
export function listLocalSessions(): string[] {
  const root = resolveNemoclawLocalDir();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, "manifest.json"))) continue;
    out.push(dir);
  }
  return out.sort();
}

// readSessionManifest loads + parses manifest.json from a session dir.
// Verification was done at run-local time (US-153); we trust the bytes here.
export function readSessionManifest(sessionDir: string): Manifest {
  const raw = readFileSync(join(sessionDir, "manifest.json"), "utf8");
  return JSON.parse(raw) as Manifest;
}

// buildSessionPayload reads every OCSF audit file from the session's
// audit/ dir and assembles the NDJSON body for the resync POST. Each
// supervisor-emitted JSON line becomes `{"kind":"audit","payload":<line>}`.
// Approval-request emission is deferred (supervisor doesn't emit them today).
export function buildSessionPayload(sessionDir: string): SessionPayload {
  const manifest = readSessionManifest(sessionDir);
  const auditDir = join(sessionDir, "audit");
  const summary = summarizeAudit(auditDir);
  const lines: string[] = [];
  for (const f of summary.files) {
    const raw = readFileSync(f.path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Wrap the supervisor's OCSF event as a resync envelope. The
      // payload is the parsed event so the operator side can validate
      // structure; if it's not JSON we skip (defensive — supervisor
      // always writes JSON, but a torn write would be garbage).
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      lines.push(JSON.stringify({ kind: "audit", payload: parsed }));
    }
  }
  return {
    sessionDir,
    deployment: manifest.deployment.name,
    bundleId: manifest.bundleId,
    ndjson: lines.length > 0 ? lines.join("\n") + "\n" : "",
    auditEventCount: lines.length,
  };
}

// resyncSession POSTs one session's NDJSON to the operator. dryRun
// returns without sending.
export async function resyncSession(
  payload: SessionPayload,
  opts: { serverUrl: string; apiKey: string; dryRun?: boolean },
): Promise<ResyncResult> {
  if (opts.dryRun) {
    return { session: payload, status: "dry-run" };
  }
  if (payload.ndjson.length === 0) {
    return { session: payload, status: "posted", httpStatus: 0, response: { skipped: "no events" } };
  }
  const url = `${stripTrailingSlash(opts.serverUrl)}/v1/offline-sessions/${encodeURIComponent(payload.deployment)}/resync`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/x-ndjson",
        [HEADER_BUNDLE_ID]: payload.bundleId,
      },
      body: payload.ndjson,
    });
  } catch (err) {
    return {
      session: payload,
      status: "failed",
      error: `network error: ${(err as Error).message}`,
    };
  }
  // Buffer the body once, then try JSON, fall back to text. Avoids
  // "Body has already been read" when JSON parse fails on an error
  // response (e.g. a plain-text 403).
  const rawBody = await resp.text();
  let body: unknown;
  try {
    body = rawBody.length > 0 ? JSON.parse(rawBody) : "";
  } catch {
    body = rawBody;
  }
  return {
    session: payload,
    status: resp.ok ? "posted" : "failed",
    httpStatus: resp.status,
    response: body,
    error: resp.ok ? undefined : `HTTP ${resp.status}`,
  };
}

export async function resync(opts: ResyncOptions): Promise<ResyncResult[]> {
  const sessions = selectSessions(opts);
  if (sessions.length === 0) {
    throw new Error(
      `no sessions to resync. Use --all, --session <name>, or --session-path <dir>. ~/.nemoclaw/local/ may be empty.`,
    );
  }
  const out: ResyncResult[] = [];
  for (const sessionDir of sessions) {
    const payload = buildSessionPayload(sessionDir);
    const result = await resyncSession(payload, {
      serverUrl: opts.serverUrl,
      apiKey: opts.apiKey,
      dryRun: opts.dryRun,
    });
    out.push(result);
  }
  return out;
}

function selectSessions(opts: ResyncOptions): string[] {
  if (opts.sessionPath) {
    if (!existsSync(opts.sessionPath)) {
      throw new Error(`session-path does not exist: ${opts.sessionPath}`);
    }
    return [opts.sessionPath];
  }
  if (opts.sessionId) {
    const dir = join(resolveNemoclawLocalDir(), opts.sessionId);
    if (!existsSync(dir)) {
      const candidates = listLocalSessions()
        .map((p) => basename(p))
        .join(", ") || "(none)";
      throw new Error(`session ${opts.sessionId} not found under ~/.nemoclaw/local/. Available: ${candidates}`);
    }
    return [dir];
  }
  if (opts.all) {
    return listLocalSessions();
  }
  return [];
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
