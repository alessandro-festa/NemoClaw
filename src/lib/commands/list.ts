// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInventory, renderSandboxInventoryText } from "../inventory";
import { NemoClawCommand } from "../cli/nemoclaw-oclif-command";
import { buildListCommandDeps } from "../list-command-deps";
import { listRemoteAssistants } from "../remote-assistants";

export default class ListCommand extends NemoClawCommand {
  static id = "list";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "List all sandboxes";
  static description =
    "List all registered sandboxes with their model, provider, and policy presets.";
  static usage = ["list [--json]"];
  static examples = ["<%= config.bin %> list", "<%= config.bin %> list --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(ListCommand);

    // SUSE remote-mode opt-in: enumerate operator-side sandboxes.
    const apiKey = process.env.NEMOCLAW_API_KEY;
    const serverUrl = process.env.NEMOCLAW_SERVER_URL;
    if (apiKey && serverUrl) {
      const assistants = await listRemoteAssistants(serverUrl, apiKey);
      if (this.jsonEnabled()) {
        return { remote: true, sandboxes: assistants };
      }
      this.log("");
      if (assistants.length === 0) {
        this.log("  No sandboxes are deployed for this api-key.");
        return;
      }
      this.log(`  ${assistants.length} sandbox(es) on ${serverUrl}:`);
      for (const a of assistants) {
        this.log(`    • ${a.name}  (${a.status}, ns=${a.namespace})`);
      }
      return;
    }

    const deps = buildListCommandDeps();
    const inventory = await getSandboxInventory(deps);
    if (this.jsonEnabled()) {
      return inventory;
    }

    const liveInference = inventory.sandboxes.length > 0 ? deps.getLiveInference() : null;
    renderSandboxInventoryText(inventory, this.log.bind(this), liveInference);
  }
}
