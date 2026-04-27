// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight client for the SUSE AI Factory operator's /v1/assistants
 * endpoints (#56). Returns the list of pre-deployed sandboxes the api-key's
 * user can attach to. Used by `nemoclaw list` and `nemoclaw <name> connect`
 * when --api-key/--server-url are supplied.
 *
 * Reuses the SSRF validator from the plugin (same pattern as
 * remote-config-fetch.ts) so private/internal IPs are rejected unless the
 * caller opts in via NEMOCLAW_ALLOW_PRIVATE_SERVER=1.
 */

const FETCH_TIMEOUT_MS = 10_000;

export interface RemoteAssistant {
  name: string;
  namespace: string;
  podName: string;
  status: string;
  ownerUser: string;
  gatewayURL: string;
  deployment: string;
}

interface AssistantsListResponse {
  assistants: RemoteAssistant[];
}

async function resolveSSRFValidator(): Promise<
  (
    url: string,
    options?: { allowPrivate?: boolean },
  ) => Promise<{ url: string; pinnedUrl: string }>
> {
  // Same import pattern as remote-config-fetch.ts — see comment there.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // @ts-ignore
  const mod = await import("../../nemoclaw/dist/blueprint/ssrf.js");
  return (
    mod as {
      validateEndpointUrl: (
        url: string,
        options?: { allowPrivate?: boolean },
      ) => Promise<{ url: string; pinnedUrl: string }>;
    }
  ).validateEndpointUrl;
}

async function fetchJSON<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Failed to reach operator at ${url}: ${String(err)}`);
  }
  if (!response.ok) {
    throw new Error(
      `Operator returned HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }
  return (await response.json()) as T;
}

export async function listRemoteAssistants(
  serverUrl: string,
  apiKey: string,
): Promise<RemoteAssistant[]> {
  const validateEndpointUrl = await resolveSSRFValidator();
  const allowPrivate = process.env.NEMOCLAW_ALLOW_PRIVATE_SERVER === "1";
  await validateEndpointUrl(serverUrl, { allowPrivate });

  const base = serverUrl.replace(/\/$/, "");
  const url = `${base}/v1/assistants?apikey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJSON<AssistantsListResponse>(url);
  return data.assistants ?? [];
}

export async function getRemoteAssistant(
  serverUrl: string,
  apiKey: string,
  name: string,
): Promise<RemoteAssistant> {
  const validateEndpointUrl = await resolveSSRFValidator();
  const allowPrivate = process.env.NEMOCLAW_ALLOW_PRIVATE_SERVER === "1";
  await validateEndpointUrl(serverUrl, { allowPrivate });

  const base = serverUrl.replace(/\/$/, "");
  const url = `${base}/v1/assistants/${encodeURIComponent(name)}?apikey=${encodeURIComponent(apiKey)}`;
  return await fetchJSON<RemoteAssistant>(url);
}
