// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Post-session audit-log summary for `nemoclaw run-local`. The supervisor
// already writes OCSF events to /var/log/openshell-ocsf.YYYY-MM-DD.log
// inside the container, which run-local bind-mounts to
// ~/.nemoclaw/local/<deployment>-<sessionId>/audit/ on the host. Rotation
// (daily, 3-file retention) is handled by the supervisor — see
// OpenShell/crates/openshell-sandbox/src/main.rs:211-222.
//
// US-155. We don't tail live: the docker run is blocking spawnSync; a
// concurrent tail would force a sync→async refactor across run-local
// for a small UX gain. A post-exit summary + a tail-it-yourself hint is
// the simplest honest delivery.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AuditSummary {
  auditDir: string;
  exists: boolean;
  files: AuditFile[];
  totalEvents: number;
}

export interface AuditFile {
  name: string;
  path: string;
  events: number;
  bytes: number;
}

const OCSF_FILE_PREFIX = "openshell-ocsf";

// summarizeAudit walks the post-session audit dir and counts OCSF events.
// Pure helper, no docker calls — safe to unit-test with fixture files.
export function summarizeAudit(auditDir: string): AuditSummary {
  if (!existsSync(auditDir)) {
    return { auditDir, exists: false, files: [], totalEvents: 0 };
  }
  const files: AuditFile[] = [];
  let totalEvents = 0;
  for (const name of readdirSync(auditDir)) {
    if (!name.startsWith(OCSF_FILE_PREFIX)) continue;
    const path = join(auditDir, name);
    const st = statSync(path);
    if (!st.isFile()) continue;
    const events = countJsonlLines(path);
    files.push({ name, path, events, bytes: st.size });
    totalEvents += events;
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { auditDir, exists: true, files, totalEvents };
}

// Read once + split — OCSF files are bounded by supervisor rotation at
// ~daily/3-file retention, so reading whole-file is fine.
function countJsonlLines(path: string): number {
  const raw = readFileSync(path, "utf8");
  if (raw.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 0x0a) count++;
  }
  // A trailing line without LF still counts as an event.
  if (raw.charCodeAt(raw.length - 1) !== 0x0a) count++;
  return count;
}

// Render a multi-line human-readable summary suitable for printing after
// the container exits. Never throws — callers expect this to be best-effort.
export function formatAuditSummary(s: AuditSummary, containerName: string): string {
  const lines: string[] = [];
  if (!s.exists) {
    lines.push(`Audit log: ${s.auditDir} not created (supervisor may have exited before emitting any events).`);
    return lines.join("\n");
  }
  if (s.files.length === 0) {
    lines.push(`Audit log: 0 OCSF files in ${s.auditDir}.`);
  } else {
    lines.push(`Audit log: ${s.totalEvents} OCSF event(s) across ${s.files.length} file(s) in ${s.auditDir}`);
    for (const f of s.files) {
      lines.push(`  - ${f.name}  (${f.events} events, ${f.bytes} bytes)`);
    }
  }
  lines.push(`Tip: to follow live in another terminal during a session, run:`);
  lines.push(`  docker exec -it ${containerName} tail -F /var/log/${OCSF_FILE_PREFIX}.*.log`);
  return lines.join("\n");
}
