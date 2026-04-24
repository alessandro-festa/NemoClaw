// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OnboardCommandOptions {
  nonInteractive: boolean;
  resume: boolean;
  recreateSandbox: boolean;
  fromDockerfile: string | null;
  acceptThirdPartySoftware: boolean;
  agent: string | null;
  dangerouslySkipPermissions: boolean;
}

export interface RunOnboardCommandDeps {
  args: string[];
  noticeAcceptFlag: string;
  noticeAcceptEnv: string;
  env: NodeJS.ProcessEnv;
  runOnboard: (options: OnboardCommandOptions) => Promise<void>;
  listAgents?: () => string[];
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export interface RunDeprecatedOnboardAliasCommandDeps extends RunOnboardCommandDeps {
  kind: "setup" | "setup-spark";
}

const ONBOARD_BASE_ARGS = [
  "--non-interactive",
  "--resume",
  "--recreate-sandbox",
  "--dangerously-skip-permissions",
];

function onboardUsageLines(noticeAcceptFlag: string): string[] {
  return [
    `  Usage: nemoclaw onboard [--non-interactive] [--resume] [--recreate-sandbox] [--from <Dockerfile>] [--agent <name>] [--dangerously-skip-permissions] [--api-key <key>] [--server-url <url>] [${noticeAcceptFlag}]`,
    "",
  ];
}

function printOnboardUsage(writer: (message?: string) => void, noticeAcceptFlag: string): void {
  for (const line of onboardUsageLines(noticeAcceptFlag)) {
    writer(line);
  }
}

/**
 * Extract `--api-key` and `--server-url` from the raw args array.
 * Returns the resolved values (flags take precedence over env vars) and the
 * remaining args with the remote-mode tokens removed so `parseOnboardArgs`
 * never sees them.
 *
 * Validation (must-have-both) is enforced here so callers get a clear error
 * message before the main args are parsed.
 */
export function extractRemoteOnboardArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: Pick<RunOnboardCommandDeps, "error" | "exit">,
  noticeAcceptFlag: string,
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
    const apiKeyValue = filtered[apiKeyIdx + 1];
    if (typeof apiKeyValue !== "string" || apiKeyValue.startsWith("--")) {
      error("  --api-key requires a value");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    apiKey = apiKeyValue;
    filtered.splice(apiKeyIdx, 2);
  }

  let serverUrl: string | null = env["NEMOCLAW_SERVER_URL"] || null;
  const serverUrlIdx = filtered.indexOf("--server-url");
  if (serverUrlIdx !== -1) {
    const serverUrlValue = filtered[serverUrlIdx + 1];
    if (typeof serverUrlValue !== "string" || serverUrlValue.startsWith("--")) {
      error("  --server-url requires a value");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    serverUrl = serverUrlValue;
    filtered.splice(serverUrlIdx, 2);
  }

  const hasApiKey = apiKey !== null;
  const hasServerUrl = serverUrl !== null;
  if (hasApiKey !== hasServerUrl) {
    error(
      hasApiKey
        ? "  --api-key requires --server-url (or NEMOCLAW_SERVER_URL) to be set as well"
        : "  --server-url requires --api-key (or NEMOCLAW_API_KEY) to be set as well",
    );
    printOnboardUsage(error, noticeAcceptFlag);
    exit(1);
  }

  return {
    filteredArgs: filtered,
    apiKey,
    serverUrl,
    remoteMode: hasApiKey && hasServerUrl,
  };
}

export function parseOnboardArgs(
  args: string[],
  noticeAcceptFlag: string,
  noticeAcceptEnv: string,
  deps: Pick<RunOnboardCommandDeps, "env" | "error" | "exit" | "listAgents">,
): OnboardCommandOptions {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const parsedArgs = [...args];

  let fromDockerfile: string | null = null;
  const fromIdx = parsedArgs.indexOf("--from");
  if (fromIdx !== -1) {
    fromDockerfile = parsedArgs[fromIdx + 1] || null;
    if (!fromDockerfile || fromDockerfile.startsWith("--")) {
      error("  --from requires a path to a Dockerfile");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    parsedArgs.splice(fromIdx, 2);
  }

  let agent: string | null = null;
  const agentIdx = parsedArgs.indexOf("--agent");
  if (agentIdx !== -1) {
    const agentValue = parsedArgs[agentIdx + 1];
    if (typeof agentValue !== "string" || agentValue.startsWith("--")) {
      error("  --agent requires a name");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    const knownAgents = deps.listAgents?.() ?? [];
    if (knownAgents.length > 0 && !knownAgents.includes(agentValue)) {
      error(`  Unknown agent '${agentValue}'. Available: ${knownAgents.join(", ")}`);
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    agent = agentValue;
    parsedArgs.splice(agentIdx, 2);
  }

  const allowedArgs = new Set([...ONBOARD_BASE_ARGS, noticeAcceptFlag]);
  const unknownArgs = parsedArgs.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    printOnboardUsage(error, noticeAcceptFlag);
    exit(1);
  }

  return {
    nonInteractive: parsedArgs.includes("--non-interactive"),
    resume: parsedArgs.includes("--resume"),
    recreateSandbox: parsedArgs.includes("--recreate-sandbox"),
    fromDockerfile,
    acceptThirdPartySoftware:
      parsedArgs.includes(noticeAcceptFlag) || String(deps.env[noticeAcceptEnv] || "") === "1",
    agent,
    dangerouslySkipPermissions: parsedArgs.includes("--dangerously-skip-permissions"),
  };
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  if (deps.args.includes("--help") || deps.args.includes("-h")) {
    printOnboardUsage(log, deps.noticeAcceptFlag);
    return;
  }

  // Extract --api-key / --server-url before the main arg parser sees them.
  // This keeps parseOnboardArgs' return shape stable (no new fields) so
  // existing callers are unaffected.  The remote-mode values are forwarded
  // to onboard() via environment variables that it already knows how to read.
  const { filteredArgs, apiKey, serverUrl, remoteMode } = extractRemoteOnboardArgs(
    deps.args,
    deps.env,
    { error, exit },
    deps.noticeAcceptFlag,
  );

  if (remoteMode) {
    // Inject into the process environment so the onboard() function can read
    // them without needing a signature change.  We deliberately do not persist
    // these beyond the current process; they are cleared after onboard() returns.
    process.env.NEMOCLAW_API_KEY = apiKey!;
    process.env.NEMOCLAW_SERVER_URL = serverUrl!;
    process.env.NEMOCLAW_REMOTE_MODE = "1";
  }

  const options = parseOnboardArgs(filteredArgs, deps.noticeAcceptFlag, deps.noticeAcceptEnv, deps);

  try {
    await deps.runOnboard(options);
  } finally {
    if (remoteMode) {
      delete process.env.NEMOCLAW_REMOTE_MODE;
      // Leave NEMOCLAW_API_KEY / NEMOCLAW_SERVER_URL as-is; they may have
      // been set by the caller before this process started.
    }
  }
}

export async function runDeprecatedOnboardAliasCommand(
  deps: RunDeprecatedOnboardAliasCommandDeps,
): Promise<void> {
  const log = deps.log ?? console.log;
  log("");
  if (deps.kind === "setup") {
    log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  } else {
    log("  ⚠  `nemoclaw setup-spark` is deprecated.");
    log("  Current OpenShell releases handle the old DGX Spark cgroup issue themselves.");
    log("  Use `nemoclaw onboard` instead.");
  }
  log("");
  await runOnboardCommand(deps);
}
