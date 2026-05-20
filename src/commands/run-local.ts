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
    "Verify the bundle's ed25519 signature against a pinned operator key, extract it to ~/.nemoclaw/local/<deployment>-<sessionId>/, then run the sandbox image fronted by the openshell-sandbox supervisor for offline policy enforcement and OCSF audit emission. See EPIC #114 (airgapped local sandbox).\n\nRuntime requirements: Linux (or macOS via Docker Desktop's Linux VM). Docker daemon must permit --cap-add=NET_ADMIN + --cap-add=SYS_ADMIN — the supervisor needs these to set up the child netns + nftables rules.";
  static usage = ["<bundle> [--allow-pull] [--trust-key <path>] [--supervisor-image <ref>]"];
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
        "Permit `docker pull` for both the sandbox image and the supervisor image when absent. Required on first run in v1.",
    }),
    "trust-key": Flags.string({
      description:
        "Trust a single ed25519 public key file (raw 32 bytes) instead of looking up under ~/.nemoclaw/trusted-keys/. For testing.",
    }),
    "supervisor-image": Flags.string({
      description:
        "Override the openshell-sandbox supervisor OCI image. Defaults to the env var NEMOCLAW_SUPERVISOR_IMAGE, else the built-in default. Must stay in sync with the operator's SupervisorImage.",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(RunLocalCommand);
    try {
      runLocal({
        bundlePath: args.bundle,
        allowPull: Boolean(flags["allow-pull"]),
        trustKeyPath: flags["trust-key"],
        supervisorImage: flags["supervisor-image"],
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
