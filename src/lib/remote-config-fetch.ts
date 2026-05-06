// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type RemoteConfig, isRemoteConfig } from "./remote-config";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Resolve the nemoclaw SSRF validator lazily so we can call it from the
 * CommonJS CLI context without a hard compile-time cross-package import.
 * The nemoclaw plugin (nemoclaw/dist/) is always present in a standard
 * NemoClaw installation; tests override this via vi.mock().
 */
async function resolveSSRFValidator(): Promise<
  (
    url: string,
    options?: { allowPrivate?: boolean },
  ) => Promise<{ url: string; pinnedUrl: string }>
> {
  // Import the plugin's compiled output rather than its TypeScript source.
  // The plugin's package.json declares "type": "module" and its tsc emits
  // ESM into nemoclaw/dist/. Pointing this import at src/ instead makes the
  // root tsc build (module: commonjs) follow the cross-package path and leak
  // a CJS-emitted ssrf.js next to the .ts source — which Node's ESM loader
  // then rejects at runtime with
  // "ReferenceError: exports is not defined in ES module scope".
  // Pre-requisite: the plugin must be built (`cd nemoclaw && npm run build`)
  // before the CLI runs. The standard install flow does this.
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

/**
 * Fetch the remote onboarding configuration from the SUSE AI Factory operator.
 *
 * SSRF protection: serverUrl is validated with DNS resolution; all resolved
 * IPs are checked against private/reserved CIDR ranges before any request is
 * made.  Uses the existing SSRF helper in nemoclaw/src/blueprint/ssrf.ts —
 * the logic is not duplicated here.
 *
 * For HTTPS endpoints the original hostname is retained so TLS certificate
 * validation remains effective against DNS-rebinding attacks.
 */
export async function fetchRemoteConfig(
  serverUrl: string,
  apiKey: string,
): Promise<RemoteConfig> {
  const validateEndpointUrl = await resolveSSRFValidator();

  // Validate and SSRF-check the server URL before making any request.
  // NEMOCLAW_ALLOW_PRIVATE_SERVER=1 unblocks dev/demo setups where the
  // operator runs on a private IP (e.g., a lima VM at 192.168.x.x). The
  // validator emits a console warning when this is in effect.
  const allowPrivate = process.env.NEMOCLAW_ALLOW_PRIVATE_SERVER === "1";
  await validateEndpointUrl(serverUrl, { allowPrivate });

  const base = serverUrl.replace(/\/$/, "");
  const url = `${base}/v1/onboarding?apikey=${encodeURIComponent(apiKey)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Failed to reach remote config server at ${serverUrl}: ${String(err)}`);
  }

  if (!response.ok) {
    throw new Error(
      `Remote config server returned HTTP ${response.status} ${response.statusText} for ${serverUrl}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`Remote config server returned non-JSON response: ${String(err)}`);
  }

  if (!isRemoteConfig(body)) {
    throw new Error(
      "Remote config response does not match expected schema. " +
        "Ensure the server is the SUSE AI Factory operator and the API key is valid.",
    );
  }

  return body;
}
