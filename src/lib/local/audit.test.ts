// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatAuditSummary, summarizeAudit } from "./audit";

describe("summarizeAudit", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns exists:false when the dir is missing", () => {
    const s = summarizeAudit(join(dir, "does-not-exist"));
    expect(s.exists).toBe(false);
    expect(s.totalEvents).toBe(0);
    expect(s.files).toEqual([]);
  });

  it("returns 0 events when dir exists but is empty", () => {
    const s = summarizeAudit(dir);
    expect(s.exists).toBe(true);
    expect(s.files).toEqual([]);
    expect(s.totalEvents).toBe(0);
  });

  it("counts JSONL lines across OCSF files, sorted by name", () => {
    writeFileSync(
      join(dir, "openshell-ocsf.2026-05-18.log"),
      '{"class_uid":4001}\n{"class_uid":4002}\n',
    );
    writeFileSync(
      join(dir, "openshell-ocsf.2026-05-19.log"),
      '{"class_uid":4001}\n{"class_uid":4001}\n{"class_uid":4007}\n',
    );
    // Unrelated file is ignored.
    writeFileSync(join(dir, "openshell.2026-05-19.log"), '{"non_ocsf":true}\n');

    const s = summarizeAudit(dir);
    expect(s.exists).toBe(true);
    expect(s.totalEvents).toBe(5);
    expect(s.files.map((f) => f.name)).toEqual([
      "openshell-ocsf.2026-05-18.log",
      "openshell-ocsf.2026-05-19.log",
    ]);
    expect(s.files[0].events).toBe(2);
    expect(s.files[1].events).toBe(3);
  });

  it("counts the final unterminated line", () => {
    // No trailing \n on the last entry — common when a process is killed mid-write.
    writeFileSync(join(dir, "openshell-ocsf.2026-05-19.log"), '{"a":1}\n{"a":2}');
    const s = summarizeAudit(dir);
    expect(s.totalEvents).toBe(2);
  });

  it("ignores subdirectories under the audit dir", () => {
    mkdirSync(join(dir, "openshell-ocsf-rotated"), { recursive: true });
    writeFileSync(join(dir, "openshell-ocsf.2026-05-19.log"), '{"a":1}\n');
    const s = summarizeAudit(dir);
    expect(s.files).toHaveLength(1);
    expect(s.totalEvents).toBe(1);
  });
});

describe("formatAuditSummary", () => {
  it("notes the dir was not created when exists:false", () => {
    const out = formatAuditSummary(
      { auditDir: "/tmp/missing", exists: false, files: [], totalEvents: 0 },
      "demo-container",
    );
    expect(out).toContain("not created");
    expect(out).toContain("/tmp/missing");
  });

  it("notes zero files when dir exists but is empty", () => {
    const out = formatAuditSummary(
      { auditDir: "/tmp/empty", exists: true, files: [], totalEvents: 0 },
      "demo-container",
    );
    expect(out).toContain("0 OCSF files");
  });

  it("renders per-file rows and a docker-exec tail hint", () => {
    const out = formatAuditSummary(
      {
        auditDir: "/tmp/audit",
        exists: true,
        totalEvents: 5,
        files: [
          { name: "openshell-ocsf.2026-05-19.log", path: "/tmp/audit/x.log", events: 5, bytes: 1024 },
        ],
      },
      "nemoclaw-local-demo-abc",
    );
    expect(out).toContain("5 OCSF event(s) across 1 file(s)");
    expect(out).toContain("openshell-ocsf.2026-05-19.log");
    expect(out).toContain("5 events, 1024 bytes");
    expect(out).toContain("docker exec -it nemoclaw-local-demo-abc tail -F");
  });
});
