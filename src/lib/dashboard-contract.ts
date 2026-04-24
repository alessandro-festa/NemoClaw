// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Delivery Contract — single source of truth for all dashboard
 * delivery config. Pure functions — no I/O, no process.env reads.
 */

import { DASHBOARD_PORT } from "./ports";
import { isLoopbackHostname } from "./url-utils";

const CONTROL_UI_PATH = "/";

/** Hints about the platform environment, passed in by callers. */
export interface PlatformHints {
  /** Raw CHAT_UI_URL value (env var or default). */
  chatUiUrl?: string;
  /** Dashboard port override (from NEMOCLAW_DASHBOARD_PORT or default). */
  port?: number;
  /** Whether running under WSL. */
  isWsl?: boolean;
  /** WSL host IP from `hostname -I`. */
  wslHostAddress?: string | null;
}

/** Resolved dashboard delivery chain — derived from PlatformHints. */
export interface DashboardDeliveryChain {
  /** The URL users open in their browser. */
  accessUrl: string;
  /** Deduped origins for gateway.controlUi.allowedOrigins. */
  corsOrigins: string[];
  /** Argument to `openshell forward start` (port-only or `0.0.0.0:port`). */
  forwardTarget: string;
  /** Always "/health". */
  healthEndpoint: string;
  /** Resolved dashboard port. */
  port: number;
  /** "127.0.0.1" or "0.0.0.0". */
  bindAddress: string;
}

/**
 * Parse a chatUiUrl string and extract the port number, falling back to
 * the provided default port on any failure.
 */
function resolvePort(chatUiUrl: string, defaultPort: number): number {
  const raw = String(chatUiUrl || "").trim();
  if (!raw) return defaultPort;
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return parsed.port ? Number(parsed.port) : defaultPort;
  } catch {
    const portMatch = raw.match(/:(\d{2,5})(?:[/?#]|$)/);
    return portMatch ? Number(portMatch[1]) : defaultPort;
  }
}

/**
 * Extract the origin (scheme + host + port) from a URL string.
 * Returns null if parsing fails.
 */
function extractOrigin(urlStr: string): string | null {
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(urlStr) ? urlStr : `http://${urlStr}`);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Check whether a chatUiUrl string represents a loopback address.
 */
function isLoopbackUrl(chatUiUrl: string): boolean {
  const raw = String(chatUiUrl || "").trim();
  if (!raw) return true;
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return /localhost|::1|127(?:\.\d{1,3}){3}/i.test(raw);
  }
}

/**
 * Build the complete dashboard delivery chain from platform hints.
 * Pure function — no process.env reads, no I/O.
 */
export function buildChain(hints?: PlatformHints): DashboardDeliveryChain {
  const h = hints || {};
  const chatUiUrl = String(h.chatUiUrl || "").trim();
  const defaultPort = DASHBOARD_PORT;
  const port = h.port ?? resolvePort(chatUiUrl, defaultPort);

  // Determine if the chatUiUrl is a non-loopback address
  const hasNonLoopbackUrl = chatUiUrl !== "" && !isLoopbackUrl(chatUiUrl);

  // Derive accessUrl
  let accessUrl: string;
  if (hasNonLoopbackUrl) {
    accessUrl = chatUiUrl;
  } else if (h.isWsl && h.wslHostAddress) {
    accessUrl = `http://${h.wslHostAddress}:${port}`;
  } else {
    accessUrl = `http://127.0.0.1:${port}`;
  }

  // Derive forwardTarget
  let forwardTarget: string;
  if (h.isWsl || hasNonLoopbackUrl) {
    forwardTarget = `0.0.0.0:${port}`;
  } else {
    forwardTarget = String(port);
  }

  const bindAddress = forwardTarget.includes(":") ? "0.0.0.0" : "127.0.0.1";

  // Build CORS origins — always include loopback first, then accessUrl origin
  const loopbackOrigin = `http://127.0.0.1:${port}`;
  const origins: string[] = [loopbackOrigin];
  const accessOrigin = extractOrigin(accessUrl);
  if (accessOrigin && accessOrigin !== loopbackOrigin) {
    origins.push(accessOrigin);
  }

  return {
    accessUrl,
    corsOrigins: origins,
    forwardTarget,
    healthEndpoint: "/health",
    port,
    bindAddress,
  };
}

/**
 * Build a URL with an optional `#token=` hash fragment.
 */
export function buildAuthenticatedDashboardUrl(
  baseUrl: string,
  token: string | null = null,
): string {
  if (!token) return baseUrl;
  return `${baseUrl}#token=${encodeURIComponent(token)}`;
}

/**
 * Build the list of control UI URLs for the dashboard.
 * No process.env reads — callers pass chatUiUrl explicitly.
 */
export function buildControlUiUrls(
  token: string | null = null,
  port: number = DASHBOARD_PORT,
  chatUiUrl?: string,
): string[] {
  const hash = token ? `#token=${token}` : "";
  const baseUrl = `http://127.0.0.1:${port}`;
  const urls = [`${baseUrl}${CONTROL_UI_PATH}${hash}`];
  const chatUi = (chatUiUrl || "").trim().replace(/\/$/, "");
  if (chatUi && /^https?:\/\//i.test(chatUi) && chatUi !== baseUrl) {
    urls.push(`${chatUi}${CONTROL_UI_PATH}${hash}`);
  }
  return [...new Set(urls)];
}

/** Options for getDashboardAccessInfo. */
export interface DashboardAccessOptions {
  wslHostAddress?: string | null;
}

/**
 * Build the dashboard access info list (label + URL pairs).
 * Moved from onboard.ts — uses chain instead of re-deriving from env.
 */
export function getDashboardAccessInfo(
  chain: DashboardDeliveryChain,
  token: string | null,
  options?: DashboardAccessOptions,
): Array<{ label: string; url: string }> {
  const dashboardAccess = buildControlUiUrls(token, chain.port, chain.accessUrl).map(
    (url, index) => ({
      label: index === 0 ? "Dashboard" : `Alt ${index}`,
      url: buildAuthenticatedDashboardUrl(url, null),
    }),
  );

  const wslHostAddress = options?.wslHostAddress;
  if (wslHostAddress) {
    const wslUrl = buildAuthenticatedDashboardUrl(
      `http://${wslHostAddress}:${chain.port}/`,
      token,
    );
    // If the WSL URL is already present (e.g. from buildControlUiUrls via
    // chain.accessUrl), relabel it rather than duplicating.
    const existing = dashboardAccess.find((access) => access.url === wslUrl);
    if (existing) {
      existing.label = "VS Code/WSL";
    } else {
      dashboardAccess.push({ label: "VS Code/WSL", url: wslUrl });
    }
  }

  return dashboardAccess;
}

/** Options for getDashboardGuidanceLines. */
export interface DashboardGuidanceOptions {
  isWsl?: boolean;
}

/**
 * Build guidance lines for dashboard access. Moved from onboard.ts.
 */
export function getDashboardGuidanceLines(
  chain: DashboardDeliveryChain,
  dashboardAccess: Array<{ label: string; url: string }>,
  options?: DashboardGuidanceOptions,
): string[] {
  const guidance = [`Port ${chain.port} must be forwarded before opening these URLs.`];
  if (options?.isWsl) {
    guidance.push(
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
    );
  }
  if (dashboardAccess.length === 0) {
    guidance.push("No dashboard URLs were generated.");
  }
  return guidance;
}
