// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { runOnboardAction } from "../global-cli-actions";
import { runRemoteOnboard } from "../remote-onboard";
import {
  buildOnboardFlags,
  onboardExamples,
  type OnboardFlags,
  onboardUsage,
  toLegacyOnboardArgs,
} from "./onboard/common";

export default class OnboardCliCommand extends Command {
  static id = "onboard";
  static strict = true;
  static summary = "Configure inference endpoint and credentials";
  static description = "Configure inference, credentials, and sandbox settings.";
  static usage = onboardUsage;
  static examples = onboardExamples;
  static flags = {
    ...buildOnboardFlags(),
    "api-key": Flags.string({
      description: "SUSE AI Factory operator API key (enables remote onboarding)",
      env: "NEMOCLAW_API_KEY",
    }),
    "server-url": Flags.string({
      description: "SUSE AI Factory operator URL (enables remote onboarding)",
      env: "NEMOCLAW_SERVER_URL",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(OnboardCliCommand);
    const apiKey = flags["api-key"] as string | undefined;
    const serverUrl = flags["server-url"] as string | undefined;
    if (apiKey && serverUrl) {
      await runRemoteOnboard({ apiKey, serverUrl });
      return;
    }
    if (apiKey || serverUrl) {
      console.error("  --api-key and --server-url must be supplied together for remote onboarding.");
      process.exit(1);
    }
    await runOnboardAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}
