// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { CLI_NAME } from "../../branding";
import { connectSandbox } from "../../sandbox-runtime-actions";
import { connectToRemoteSandbox } from "../../remote-connect";

export default class ConnectCliCommand extends Command {
  static id = "sandbox:connect";
  static strict = true;
  static summary = "Shell into a running sandbox";
  static description = "Connect to a running sandbox.";
  static usage = [
    "<name> connect [--probe-only]",
    "<name> connect --api-key=… --server-url=…",
  ];
  static examples = [
    "<%= config.bin %> alpha connect",
    "<%= config.bin %> alpha connect --probe-only",
    "<%= config.bin %> alpha connect --api-key=K --server-url=https://operator",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    "probe-only": Flags.boolean({ description: "Recover and check the sandbox without opening SSH" }),
    "dangerously-skip-permissions": Flags.boolean({ hidden: true }),
    "api-key": Flags.string({
      description: "SUSE AI Factory operator API key (connects via SSH tunnel, no kubectl)",
      env: "NEMOCLAW_API_KEY",
    }),
    "server-url": Flags.string({
      description: "SUSE AI Factory operator URL (connects via SSH tunnel, no kubectl)",
      env: "NEMOCLAW_SERVER_URL",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ConnectCliCommand);
    if (flags["dangerously-skip-permissions"]) {
      console.error("  --dangerously-skip-permissions was removed; use shields commands instead.");
      console.error(`  Usage: ${CLI_NAME} <name> connect [--probe-only]`);
      process.exit(1);
    }
    const apiKey = flags["api-key"] as string | undefined;
    const serverUrl = flags["server-url"] as string | undefined;
    if (apiKey && serverUrl) {
      const exitCode = await connectToRemoteSandbox({
        serverUrl,
        apiKey,
        sandboxName: args.sandboxName,
      });
      process.exit(exitCode);
    }
    if (apiKey || serverUrl) {
      console.error("  --api-key and --server-url must be supplied together for remote connect.");
      process.exit(1);
    }
    await connectSandbox(args.sandboxName, {
      probeOnly: Boolean(flags["probe-only"]),
    });
  }
}
