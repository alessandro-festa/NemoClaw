// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration payload returned by the SUSE AI Factory with NVIDIA operator
 * at GET /v1/onboarding. Used to bypass the interactive onboarding wizard.
 */
export interface RemoteConfig {
  /** Schema version — starts at "1". */
  version: string;
  blueprintId: string;
  blueprintVersion: string;
  isolationMode: "Shared" | "Isolated" | "Hybrid";
  /** Full URL to the inference endpoint. */
  inferenceEndpoint: string;
  inferenceProviderType: "nvidia" | "openai" | "ollama";
  inferenceModel: string;
  /** Full URL to the OpenShell gateway endpoint. */
  gatewayEndpoint: string;
  /** Fully-qualified container image reference for the sandbox. */
  sandboxImage: string;
  /** Optional path to the OPA/Rego policy bundle. */
  policyBundleRef?: string;
  /**
   * Per-sandbox OpenClaw Web UI URL with the token already substituted.
   * Omitted by the operator when the token isn't published yet (sandbox
   * not started, or webui-token-publisher sidecar still polling for the
   * openclaw config) so we never hand the user a non-working link.
   * Refs aif-nc PR-C, claude#87.
   */
  webUIUrl?: string;
}

/** Type guard — returns true when obj satisfies the RemoteConfig interface. */
export function isRemoteConfig(obj: unknown): obj is RemoteConfig {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.version === "string" &&
    typeof r.blueprintId === "string" &&
    typeof r.blueprintVersion === "string" &&
    (r.isolationMode === "Shared" ||
      r.isolationMode === "Isolated" ||
      r.isolationMode === "Hybrid") &&
    typeof r.inferenceEndpoint === "string" &&
    (r.inferenceProviderType === "nvidia" ||
      r.inferenceProviderType === "openai" ||
      r.inferenceProviderType === "ollama") &&
    typeof r.inferenceModel === "string" &&
    typeof r.gatewayEndpoint === "string" &&
    typeof r.sandboxImage === "string" &&
    (r.policyBundleRef === undefined || typeof r.policyBundleRef === "string") &&
    (r.webUIUrl === undefined || typeof r.webUIUrl === "string")
  );
}
