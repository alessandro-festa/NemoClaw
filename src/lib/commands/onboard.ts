// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { runOnboardAction } from "../actions/global";
import { loadSession } from "../state/onboard-session";
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
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    // SUSE remote-mode opt-in: when both env vars are set, bypass the
    // interactive wizard and configure against the SUSE AI Factory operator.
    let apiKey = process.env.NEMOCLAW_API_KEY;
    let serverUrl = process.env.NEMOCLAW_SERVER_URL;

    // #59: hydrate remote credentials from the persisted session on
    // `--resume` with no flags, so a previously-onboarded remote session
    // doesn't fall back to the local interactive wizard. Only kicks in
    // when the env vars are unset on this invocation; explicit flags or
    // env always win.
    if ((!apiKey || !serverUrl) && process.argv.includes("--resume")) {
      const session = loadSession();
      if (session?.remoteOnboard) {
        apiKey = apiKey || session.remoteOnboard.apiKey;
        serverUrl = serverUrl || session.remoteOnboard.serverUrl;
      }
    }

    if (apiKey && serverUrl) {
      await runRemoteOnboard({ apiKey, serverUrl });
      return;
    }

    const { flags } = await this.parse(OnboardCliCommand);
    await runOnboardAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}
