// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { ConnectIntentError, fetchDisconnectIntent } from "../../remote-connect";

/**
 * Remote-mode-only command. Patches the operator-managed Sandbox CR's
 * spec.replicas to 0 so the pod scales down. Workspace PVC and api-key
 * survive — reconnect with `nemoclaw <name> connect`.
 *
 * No local-mode equivalent: in local mode the user kills their own shell
 * and the local Docker container stays running until `nemoclaw stop`.
 */
export default class DisconnectCliCommand extends Command {
  static id = "sandbox:disconnect";
  static strict = true;
  static summary = "Disconnect from a remote sandbox (scales it to 0)";
  static description =
    "Scales the operator-managed sandbox back to 0 replicas. The workspace volume and api-key are preserved — reconnect later with `<name> connect`.";
  static usage = ["<name> disconnect --api-key=… --server-url=…"];
  static examples = [
    "<%= config.bin %> alpha disconnect --api-key=K --server-url=https://operator",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    "api-key": Flags.string({
      description: "SUSE AI Factory operator API key",
      env: "NEMOCLAW_API_KEY",
      required: true,
    }),
    "server-url": Flags.string({
      description: "SUSE AI Factory operator URL",
      env: "NEMOCLAW_SERVER_URL",
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DisconnectCliCommand);
    const apiKey = flags["api-key"] as string;
    const serverUrl = flags["server-url"] as string;
    const name = args.sandboxName;

    this.log("");
    this.log(`  Requesting disconnect-intent for sandbox '${name}'...`);

    try {
      const resp = await fetchDisconnectIntent(serverUrl, apiKey, name);
      this.log(
        `  Sandbox '${resp.sandboxName}' scaled to ${resp.replicas} (was ${resp.status}).`,
      );
      this.log(
        `  Workspace and api-key are preserved — reconnect with: nemoclaw ${name} connect`,
      );
    } catch (err) {
      if (err instanceof ConnectIntentError) {
        this.error(err.message, { exit: 1 });
      }
      throw err;
    }
  }
}
