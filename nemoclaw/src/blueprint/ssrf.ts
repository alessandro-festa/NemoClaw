// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { promises as dnsPromises } from "node:dns";

import { isPrivateIp, isPrivateHostname } from "./private-networks.js";

// Re-export so consumers can pick the narrower IP-only check (for
// post-DNS addresses) or the broader name-aware check (for user input).
export { isPrivateIp, isPrivateHostname };

const ALLOWED_SCHEMES = new Set(["https:", "http:"]);

/**
 * Result of endpoint URL validation with DNS pinning.
 *
 * `url` is the original URL (hostname intact).
 * `pinnedUrl` has the hostname replaced with the first resolved IP, preventing
 * DNS rebinding TOCTOU attacks where an attacker returns a public IP at
 * validation time and a private IP at connection time.
 *
 * Callers should use `pinnedUrl` for HTTP endpoints (full protection) and `url`
 * for HTTPS endpoints (TLS certificate validation prevents rebinding since the
 * attacker cannot present a valid cert for the rebinding target).
 */
export interface ValidatedEndpoint {
  url: string;
  pinnedUrl: string;
}

export interface ValidateEndpointOptions {
  /**
   * When true, resolved IPs in private/reserved CIDR ranges are allowed
   * (a warning is emitted instead of throwing). Use only for dev/demo
   * setups where the operator legitimately runs on a private IP (lima
   * VM, homelab k8s, etc.). Production callers MUST leave this false.
   */
  allowPrivate?: boolean;
}

export async function validateEndpointUrl(
  url: string,
  options: ValidateEndpointOptions = {},
): Promise<ValidatedEndpoint> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`No hostname found in URL: ${url}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    const scheme = parsed.protocol.replace(":", "");
    throw new Error(
      `Unsupported URL scheme '${scheme}://'. Only ${[...ALLOWED_SCHEMES].map((s) => s.replace(":", "://")).join(", ")} are allowed.`,
    );
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error(`No hostname found in URL: ${url}`);
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`Cannot resolve hostname '${hostname}': ${String(err)}`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      if (options.allowPrivate) {
        console.warn(
          `  ⚠ Endpoint URL ${url} resolves to private/internal address ${address}. ` +
            "Allowed because allowPrivate is set — do not use in production.",
        );
        continue;
      }
      throw new Error(
        `Endpoint URL resolves to private/internal address ${address}. ` +
          "Connections to internal networks are not allowed.",
      );
    }
  }

  // DNS pinning: replace hostname with the first validated IP to prevent
  // TOCTOU rebinding between validation and connection time.
  const pinned = new URL(url);
  const first = addresses[0];
  pinned.hostname = first.family === 6 ? `[${first.address}]` : first.address;

  return { url, pinnedUrl: pinned.toString() };
}
