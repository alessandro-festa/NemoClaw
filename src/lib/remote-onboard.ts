// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fetchRemoteConfig } from "./remote-config-fetch";
import { listRemoteAssistants } from "./remote-assistants";
import { loadSession, saveSession, createSession } from "./onboard-session";

/**
 * Remote-mode onboarding for `nemoclaw onboard --api-key X --server-url Y`.
 *
 * Replaces the legacy 337-line patch into the local `onboard.ts` wizard.
 * The aif-nc operator pre-provisions everything via Blueprint+Deployment,
 * so this command no longer needs to kubectl-exec into the sandbox pod
 * to configure the assistant — it only validates credentials, fetches the
 * RemoteConfig, and lists the sandboxes the user can connect to.
 *
 * No kubectl on the user's laptop. The credentials are persisted to the
 * onboard session (~/.nemoclaw/onboard-session.json, dir 0o700, file 0o600
 * — same posture as ~/.ssh/) so a subsequent `nemoclaw onboard --resume`
 * with no flags can hydrate process.env and continue in remote mode (#59).
 * Other commands (`list`, `<name> connect`, `<name> disconnect`) still
 * take the same `--api-key` / `--server-url` flags / env vars explicitly.
 */
export async function runRemoteOnboard(opts: {
  apiKey: string;
  serverUrl: string;
}): Promise<void> {
  const config = await fetchRemoteConfig(opts.serverUrl, opts.apiKey);
  const assistants = await listRemoteAssistants(opts.serverUrl, opts.apiKey);

  // Persist remote credentials to the session so --resume can pick them
  // back up. Done after the network calls succeed so a failed onboard
  // doesn't seed a session pointing at unreachable coordinates.
  const existing = loadSession();
  const next = existing
    ? { ...existing, remoteOnboard: { apiKey: opts.apiKey, serverUrl: opts.serverUrl } }
    : createSession({
        mode: "remote",
        remoteOnboard: { apiKey: opts.apiKey, serverUrl: opts.serverUrl },
      });
  saveSession(next);

  console.log("");
  console.log(`  ✓ Onboarded against ${opts.serverUrl}`);
  console.log(`    Blueprint: ${config.blueprintId} (v${config.blueprintVersion})`);
  console.log(`    Isolation: ${config.isolationMode}`);
  console.log(`    Inference: ${config.inferenceProviderType} / ${config.inferenceModel}`);
  console.log("");

  if (assistants.length === 0) {
    console.log("  No sandboxes are deployed for this api-key yet.");
    console.log("  Ask your administrator to provision one in the SUSE AI Factory UI.");
    return;
  }

  console.log(`  ${assistants.length} sandbox(es) available:`);
  for (const a of assistants) {
    console.log(`    • ${a.name}  (${a.status}, ns=${a.namespace})`);
  }
  console.log("");
  console.log(
    "  Connect with: nemoclaw <name> connect --api-key=… --server-url=…",
  );
}
