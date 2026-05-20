// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { resync, type ResyncResult } from "../lib/actions/resync";

export default class ResyncCommand extends NemoClawCommand {
  static id = "resync";
  static strict = true;
  static summary = "Resync local airgapped session audit logs to the operator";
  static description =
    "POSTs the OCSF audit events captured during a `nemoclaw run-local` session back to the operator's offline-session ingest endpoint (EPIC #114 US-156). The operator stores each session by bundleId; calls are idempotent against the same bundleId (the operator replaces audit-events.ndjson on each call). Server URL + apikey can be supplied via flags or env (NEMOCLAW_AIF_SERVER_URL / NEMOCLAW_AIF_API_KEY).";
  static usage = ["[--all|--session <name>|--session-path <dir>] [--server-url <url>] [--api-key <key>] [--dry-run]"];
  static examples = [
    "<%= config.bin %> resync --all --server-url https://aif.example.com --api-key $NEMOCLAW_AIF_API_KEY",
    "<%= config.bin %> resync --session demo-abc12345 --dry-run",
    "NEMOCLAW_AIF_SERVER_URL=https://aif.example.com NEMOCLAW_AIF_API_KEY=… <%= config.bin %> resync --all",
  ];
  static args = {};
  static flags = {
    all: Flags.boolean({
      description: "Resync every session dir under ~/.nemoclaw/local/.",
      exclusive: ["session", "session-path"],
    }),
    session: Flags.string({
      description: "Bare session name (the dir under ~/.nemoclaw/local/).",
      exclusive: ["all", "session-path"],
    }),
    "session-path": Flags.string({
      description: "Absolute path to a session dir (escape hatch outside ~/.nemoclaw/local/).",
      exclusive: ["all", "session"],
    }),
    "server-url": Flags.string({
      description: "AIF operator base URL (e.g. https://aif.example.com). Defaults to env NEMOCLAW_AIF_SERVER_URL.",
    }),
    "api-key": Flags.string({
      description: "AIF apikey for the deployment. Defaults to env NEMOCLAW_AIF_API_KEY.",
    }),
    "dry-run": Flags.boolean({
      description: "Build the payload + print a summary, but don't POST.",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ResyncCommand);
    const serverUrl = flags["server-url"] ?? process.env.NEMOCLAW_AIF_SERVER_URL ?? "";
    const apiKey = flags["api-key"] ?? process.env.NEMOCLAW_AIF_API_KEY ?? "";
    const dryRun = Boolean(flags["dry-run"]);
    if (!dryRun) {
      if (!serverUrl) {
        this.failWithLines([
          "missing --server-url (or env NEMOCLAW_AIF_SERVER_URL)",
        ]);
        return;
      }
      if (!apiKey) {
        this.failWithLines([
          "missing --api-key (or env NEMOCLAW_AIF_API_KEY)",
        ]);
        return;
      }
    }
    let results: ResyncResult[];
    try {
      results = await resync({
        serverUrl,
        apiKey,
        sessionPath: flags["session-path"],
        sessionId: flags.session,
        all: Boolean(flags.all),
        dryRun,
      });
    } catch (err) {
      this.failWithLines([(err as Error).message]);
      return;
    }
    let failed = 0;
    for (const r of results) {
      const head = `${r.session.deployment}/${r.session.bundleId}`;
      if (r.status === "dry-run") {
        console.log(`[dry-run] ${head}  ${r.session.auditEventCount} events ready`);
      } else if (r.status === "posted") {
        console.log(`[ok]      ${head}  ${r.session.auditEventCount} events  HTTP ${r.httpStatus ?? "-"}`);
      } else {
        failed++;
        console.error(`[fail]    ${head}  ${r.error ?? "unknown"}`);
      }
    }
    if (failed > 0) {
      this.failWithLines([`${failed} session(s) failed to resync`]);
    }
  }
}
