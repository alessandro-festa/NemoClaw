// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { runLocal } from "../lib/actions/run-local";
import { BundleVerifyError } from "../lib/bundle/verify";

export default class RunLocalCommand extends NemoClawCommand {
  static id = "run-local";
  static strict = true;
  static summary = "Launch a sandbox from a signed offline bundle";
  static description =
    "Verify the bundle's ed25519 signature against a pinned operator key, extract it to ~/.nemoclaw/local/<deployment>-<sessionId>/, then `docker run -it` the sandbox image and drop the user into an interactive shell. See EPIC #114 (airgapped local sandbox).";
  static usage = ["<bundle> [--allow-pull] [--trust-key <path>]"];
  static examples = [
    "<%= config.bin %> run-local mydeployment.nemoclaw-bundle --allow-pull",
    "<%= config.bin %> run-local mydeployment.nemoclaw-bundle --trust-key /tmp/test.pub --allow-pull",
  ];
  static args = {
    bundle: Args.string({
      name: "bundle",
      description: "Path to a .nemoclaw-bundle file",
      required: true,
    }),
  };
  static flags = {
    "allow-pull": Flags.boolean({
      description:
        "Permit `docker pull` when sandboxImage.embedded=false. Required in v1 since bundles ship without embedded images.",
    }),
    "trust-key": Flags.string({
      description:
        "Trust a single ed25519 public key file (raw 32 bytes) instead of looking up under ~/.nemoclaw/trusted-keys/. For testing.",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(RunLocalCommand);
    try {
      runLocal({
        bundlePath: args.bundle,
        allowPull: Boolean(flags["allow-pull"]),
        trustKeyPath: flags["trust-key"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof BundleVerifyError) {
        this.failWithLines(["Bundle verification failed:", `  ${msg}`]);
      } else {
        this.failWithLines([msg]);
      }
    }
  }
}
