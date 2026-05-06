// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { getSandboxInventory, renderSandboxInventoryText } from "../inventory-commands";
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
  static usage = ["list [--json]", "list --api-key=… --server-url=… [--json]"];
  static examples = [
    "<%= config.bin %> list",
    "<%= config.bin %> list --json",
    "<%= config.bin %> list --api-key=K --server-url=https://operator",
  ];
  static flags = {
    "api-key": Flags.string({
      description: "SUSE AI Factory operator API key (enables remote listing)",
      env: "NEMOCLAW_API_KEY",
    }),
    "server-url": Flags.string({
      description: "SUSE AI Factory operator URL (enables remote listing)",
      env: "NEMOCLAW_SERVER_URL",
    }),
  };

  public async run(): Promise<unknown> {
    const { flags } = await this.parse(ListCommand);
    const apiKey = flags["api-key"] as string | undefined;
    const serverUrl = flags["server-url"] as string | undefined;
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
    if (apiKey || serverUrl) {
      this.error("--api-key and --server-url must be supplied together for remote listing.");
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
