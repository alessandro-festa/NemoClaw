// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { CLI_NAME } from "../../cli/branding";
import { connectSandbox } from "../../actions/sandbox/connect";
import { connectToRemoteSandbox } from "../../remote-connect";

export default class ConnectCliCommand extends NemoClawCommand {
  static id = "sandbox:connect";
  static strict = true;
  static summary = "Shell into a running sandbox";
  static description = "Connect to a running sandbox.";
  static usage = ["<name> [--probe-only]"];
  static examples = [
    "<%= config.bin %> sandbox connect alpha",
    "<%= config.bin %> sandbox connect alpha --probe-only",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    "probe-only": Flags.boolean({ description: "Recover and check the sandbox without opening SSH" }),
    "dangerously-skip-permissions": Flags.boolean({ hidden: true }),
  };

  public async run(): Promise<void> {
    // SUSE remote-mode opt-in: SSH-tunnel via the SUSE AI Factory operator
    // (no kubectl on the user's laptop). Activated by env vars only so we
    // don't extend upstream's flag surface.
    const apiKey = process.env.NEMOCLAW_API_KEY;
    const serverUrl = process.env.NEMOCLAW_SERVER_URL;
    if (apiKey && serverUrl) {
      const { args } = await this.parse(ConnectCliCommand);
      const exitCode = await connectToRemoteSandbox({
        serverUrl,
        apiKey,
        sandboxName: args.sandboxName,
      });
      process.exit(exitCode);
    }

    const { args, flags } = await this.parse(ConnectCliCommand);
    if (flags["dangerously-skip-permissions"]) {
      this.failWithLines([
        "  --dangerously-skip-permissions was removed; use shields commands instead.",
        `  Usage: ${CLI_NAME} <name> connect [--probe-only]`,
      ]);
      return;
    }
    await connectSandbox(args.sandboxName, {
      probeOnly: Boolean(flags["probe-only"]),
    });
  }
}
