// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSessionPayload, readSessionManifest, resyncSession } from "./resync";

function writeManifest(dir: string, overrides: Partial<Record<string, unknown>> = {}) {
  const manifest = {
    version: "1",
    bundleId: "ca6c1a23-4f2e-4d47-87aa-f1faa5a28ae1",
    createdAt: "2026-05-19T00:00:00Z",
    deployment: { name: "demo", namespace: "aif-system", uid: "u1", generation: 1 },
    blueprint: { name: "bp", version: "0.1.0" },
    sandboxImage: { ref: "ghcr.io/example/img@sha256:abc", embedded: false },
    policy: { snapshotPath: "policy/effective.yaml", rulesPath: "policy/rules.rego", tier: "default" },
    cursor: { deploymentGeneration: 1 },
    files: [],
    signature: { scheme: "ed25519", publicKeyFingerprint: "sha256:abc" },
    ...overrides,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

describe("readSessionManifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resync-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses a v1 manifest", () => {
    writeManifest(dir);
    const m = readSessionManifest(dir);
    expect(m.deployment.name).toBe("demo");
    expect(m.bundleId).toBe("ca6c1a23-4f2e-4d47-87aa-f1faa5a28ae1");
  });
});

describe("buildSessionPayload", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resync-test-"));
    writeManifest(dir);
    mkdirSync(join(dir, "audit"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty NDJSON when no audit files exist", () => {
    const p = buildSessionPayload(dir);
    expect(p.deployment).toBe("demo");
    expect(p.bundleId).toBe("ca6c1a23-4f2e-4d47-87aa-f1faa5a28ae1");
    expect(p.ndjson).toBe("");
    expect(p.auditEventCount).toBe(0);
  });

  it("wraps each OCSF event as {kind:audit, payload}", () => {
    writeFileSync(
      join(dir, "audit", "openshell-ocsf.2026-05-19.log"),
      '{"class_uid":4001,"action_id":1}\n{"class_uid":4002,"action_id":2}\n',
    );
    const p = buildSessionPayload(dir);
    expect(p.auditEventCount).toBe(2);
    const lines = p.ndjson.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.kind).toBe("audit");
    expect(first.payload).toEqual({ class_uid: 4001, action_id: 1 });
  });

  it("skips malformed lines defensively", () => {
    writeFileSync(
      join(dir, "audit", "openshell-ocsf.2026-05-19.log"),
      '{"class_uid":4001}\nnot json\n{"class_uid":4002}\n',
    );
    const p = buildSessionPayload(dir);
    expect(p.auditEventCount).toBe(2);
  });

  it("concatenates multiple OCSF files (sorted by name)", () => {
    writeFileSync(join(dir, "audit", "openshell-ocsf.2026-05-18.log"), '{"i":1}\n');
    writeFileSync(join(dir, "audit", "openshell-ocsf.2026-05-19.log"), '{"i":2}\n{"i":3}\n');
    const p = buildSessionPayload(dir);
    expect(p.auditEventCount).toBe(3);
  });
});

describe("resyncSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resync-test-"));
    writeManifest(dir);
    mkdirSync(join(dir, "audit"), { recursive: true });
    writeFileSync(join(dir, "audit", "openshell-ocsf.2026-05-19.log"), '{"a":1}\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("dry-run skips fetch", async () => {
    const payload = buildSessionPayload(dir);
    const result = await resyncSession(payload, {
      serverUrl: "https://aif.example.com",
      apiKey: "abc",
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
  });

  it("POSTs NDJSON with bundle-id header + bearer auth", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: 1, conflicts: [], serverSessionId: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const payload = buildSessionPayload(dir);
    const result = await resyncSession(payload, {
      serverUrl: "https://aif.example.com/",
      apiKey: "abc",
    });
    expect(result.status).toBe("posted");
    expect(result.httpStatus).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://aif.example.com/v1/offline-sessions/demo/resync");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc");
    expect(headers["X-Nemoclaw-Bundle-Id"]).toBe("ca6c1a23-4f2e-4d47-87aa-f1faa5a28ae1");
    expect(headers["Content-Type"]).toBe("application/x-ndjson");
  });

  it("treats non-2xx as failed and surfaces the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );
    const payload = buildSessionPayload(dir);
    const result = await resyncSession(payload, {
      serverUrl: "https://aif.example.com",
      apiKey: "abc",
    });
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(403);
    expect(result.error).toMatch(/403/);
  });

  it("surfaces network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const payload = buildSessionPayload(dir);
    const result = await resyncSession(payload, {
      serverUrl: "https://aif.example.com",
      apiKey: "abc",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("skips the POST when ndjson is empty (no events captured)", async () => {
    const empty: typeof buildSessionPayload extends () => infer R ? R : never = {
      sessionDir: dir,
      deployment: "demo",
      bundleId: "x",
      ndjson: "",
      auditEventCount: 0,
    } as never;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await resyncSession(empty, {
      serverUrl: "https://aif.example.com",
      apiKey: "abc",
    });
    expect(result.status).toBe("posted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
