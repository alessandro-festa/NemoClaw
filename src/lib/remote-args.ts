// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic remote-mode flag extraction shared by every nemoclaw subcommand
 * that may target a remote SUSE AI Factory operator (#56). Pulls
 * `--api-key <K>` and `--server-url <U>` out of the args array (or the
 * matching env vars NEMOCLAW_API_KEY / NEMOCLAW_SERVER_URL) and returns
 * them along with the cleaned args so the per-command parser never sees
 * the remote flags.
 *
 * Mirrors the validation in extractRemoteOnboardArgs but is command-agnostic
 * (no usage banner). Callers that want a usage hint print one themselves
 * after the error.
 */
export function extractRemoteArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: { error?: (message?: string) => void; exit?: (code: number) => never } = {},
): {
  filteredArgs: string[];
  apiKey: string | null;
  serverUrl: string | null;
  remoteMode: boolean;
} {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const filtered = [...args];

  let apiKey: string | null = env["NEMOCLAW_API_KEY"] || null;
  const apiKeyIdx = filtered.indexOf("--api-key");
  if (apiKeyIdx !== -1) {
    const value = filtered[apiKeyIdx + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      error("  --api-key requires a value");
      exit(1);
    }
    apiKey = value;
    filtered.splice(apiKeyIdx, 2);
  }

  let serverUrl: string | null = env["NEMOCLAW_SERVER_URL"] || null;
  const serverUrlIdx = filtered.indexOf("--server-url");
  if (serverUrlIdx !== -1) {
    const value = filtered[serverUrlIdx + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      error("  --server-url requires a value");
      exit(1);
    }
    serverUrl = value;
    filtered.splice(serverUrlIdx, 2);
  }

  const hasApiKey = apiKey !== null;
  const hasServerUrl = serverUrl !== null;
  if (hasApiKey !== hasServerUrl) {
    error(
      hasApiKey
        ? "  --api-key requires --server-url (or NEMOCLAW_SERVER_URL)"
        : "  --server-url requires --api-key (or NEMOCLAW_API_KEY)",
    );
    exit(1);
  }

  return {
    filteredArgs: filtered,
    apiKey,
    serverUrl,
    remoteMode: hasApiKey && hasServerUrl,
  };
}
