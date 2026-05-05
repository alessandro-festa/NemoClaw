---
name: "nemoclaw-user-configure-inference"
description: "Connects NemoClaw to a local inference server. Use when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw. Trigger keywords - nemoclaw local inference, ollama nemoclaw, vllm nemoclaw, local model server, openai compatible endpoint, switch nemoclaw inference model, change inference runtime, nemoclaw additional model, nemoclaw sub-agent model, openclaw sub-agent, agents.list, sessions_spawn, vlm-demo, nemoclaw inference options, nemoclaw onboarding providers, nemoclaw inference routing."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use a Local Inference Server with NemoClaw

OpenClaw documents the sub-agent behavior, `sessions_spawn` tool, `agents.list` configuration, tool policy, nesting, and auth model in [Sub-Agents](https://docs.openclaw.ai/tools/subagents).
Use that page as the source of truth for how OpenClaw sub-agents work.

- NemoClaw installed.
- A local model server running, or an Ollama setup that the NemoClaw onboard wizard can use, start, or install.

NemoClaw can route inference to a model server running on your machine instead of a cloud API.
This page covers Ollama, compatible-endpoint paths for other servers, and two experimental options for vLLM and NVIDIA NIM.

All approaches use the same `inference.local` routing model.
The agent inside the sandbox never connects to your model server directly.
OpenShell intercepts inference traffic and forwards it to the local endpoint you configure.

## Step 1: Ollama

Ollama is the default local inference option.
The onboard wizard detects Ollama automatically when it is installed or running on the host.

If Ollama is installed but not running, NemoClaw starts it for you.
On macOS and Linux, the wizard can also offer to install Ollama when it is not present.
On WSL, the wizard can use, start, restart, or install Ollama on the Windows host through PowerShell interop.

Run the onboard wizard.

```console
$ nemoclaw onboard
```

Select **Local Ollama** from the provider list.
NemoClaw lists installed models or offers starter models if none are installed.
It pulls the selected model, loads it into memory, and validates it before continuing.
On WSL, if you choose the Windows-host Ollama path, NemoClaw uses `host.docker.internal:11434` and pulls missing models through the Ollama HTTP API instead of requiring the `ollama` CLI inside WSL.

### WSL with Windows-Host Ollama

When NemoClaw runs inside WSL, the provider menu can include Windows-host Ollama actions:

- **Use Ollama on Windows host** when the Windows daemon is already reachable.
- **Restart Ollama on Windows host** when the daemon is installed but only bound to Windows loopback.
- **Start Ollama on Windows host** when Ollama is installed but not running.
- **Install Ollama on Windows host** when Windows does not have Ollama installed.

The install and restart paths set `OLLAMA_HOST=0.0.0.0:11434` on the Windows side so Docker and WSL can reach the daemon through `host.docker.internal`.
Use one Ollama instance on port `11434` at a time.
If both WSL and Windows-host Ollama are running, pick the intended menu entry during onboarding so NemoClaw validates and pulls models against the right daemon.

### Authenticated Reverse Proxy

On non-WSL hosts, NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated reverse proxy on `0.0.0.0:11435`.
Containers and other hosts on the local network reach Ollama only through the
proxy, which validates a Bearer token before forwarding requests.
Ollama itself is never exposed without authentication.

WSL Ollama paths do not use this proxy.
Windows-host Ollama uses the Windows daemon through `host.docker.internal`.

For non-WSL Ollama setups, the onboard wizard manages the proxy automatically:

- Generates a random 24-byte token on first run and stores it in
  `~/.nemoclaw/ollama-proxy-token` with `0600` permissions.
- Starts the proxy after Ollama and verifies it before continuing.
- Cleans up stale proxy processes from previous runs.
- Retries the sandbox container reachability check and can continue when the host-side proxy is healthy even if the container probe fails.
- Reuses the persisted token after a host reboot so you do not need to re-run
  onboard.

The sandbox provider is configured to use proxy port `11435` with the generated
token as its `OPENAI_API_KEY` credential.
OpenShell's L7 proxy injects the token at egress, so the agent inside the
sandbox never sees the token directly.

`GET /api/tags` is exempt from authentication so container health checks
continue to work.
All other endpoints (including `POST /api/tags`) require the Bearer token.

If Ollama is already running on a non-loopback address when you start onboard,
the wizard restarts it on `127.0.0.1:11434` so the proxy is the only network
path to the model server.

### GPU Memory Cleanup

When you switch away from Ollama, stop host services, or destroy an Ollama-backed sandbox, NemoClaw asks Ollama to unload currently loaded models from GPU memory.
The cleanup sends `keep_alive: 0` for each model reported by Ollama and runs on a best-effort basis, so shutdown continues if Ollama is already stopped.
This does not delete downloaded model files.

### Non-Interactive Setup

```console
$ NEMOCLAW_PROVIDER=ollama \
  NEMOCLAW_MODEL=qwen2.5:14b \
  nemoclaw onboard --non-interactive --yes
```

If `NEMOCLAW_MODEL` is not set, NemoClaw selects a default model based on available memory.

`--yes` (or `NEMOCLAW_YES=1`) authorises the Ollama model download without an interactive confirmation prompt.
Under `--non-interactive`, `--yes` (or `NEMOCLAW_YES=1`) is required to authorise the download — onboard exits otherwise, since it cannot prompt.
Run onboard without `--non-interactive` to get the interactive `[y/N]` prompt that shows the model size before downloading.

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `ollama`. |
| `NEMOCLAW_MODEL` | Ollama model tag to use. Optional. |
| `NEMOCLAW_YES` | Set to `1` to auto-accept the model-download confirmation prompt. Optional. |

## Step 2: OpenAI-Compatible Server

## Step 2: Omni Vision Sub-Agent Example

The [`vlm-demo`](https://github.com/brevdev/nemoclaw-demos/tree/main/vlm-demo) applies the OpenClaw sub-agent pattern to a vision task.
It keeps the primary `main` agent on the normal NemoClaw inference route and adds a `vision-operator` sub-agent backed by an Omni vision model.

| OpenClaw field | Omni example value |
|---|---|
| Primary agent | `main` |
| Primary model | `inference/nvidia/nemotron-3-super-120b-a12b` |
| Auxiliary provider | `nvidia-omni` |
| Sub-agent | `vision-operator` |
| Sub-agent model | `nvidia-omni/private/nvidia/nemotron-3-nano-omni-reasoning-30b-a3b` |
| Delegation tool | `sessions_spawn` |

Omni is used as the specialist model for image tasks.
The primary orchestration model remains responsible for conversation, planning, and deciding when to delegate.

## Step 3: Update the Sandbox Config

Fetch the current OpenClaw config from the sandbox, patch it with your auxiliary provider and `agents.list` changes, then upload it back.

```console
$ export SANDBOX=my-assistant
$ export DOCKER_CTR=openshell-cluster-nemoclaw
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- cat /sandbox/.openclaw/openclaw.json > /tmp/openclaw.json
```

Create `/tmp/openclaw.updated.json` with the OpenClaw sub-agent config.
For the Omni example, the demo provides `vlm-demo/vlm-subagent/openclaw-patch.py`.

| Variable | Values | Default |
|---|---|---|
| `NEMOCLAW_PREFERRED_API` | `openai-completions`, `openai-responses` | `openai-completions` for compatible endpoints |

If you already onboarded and the sandbox is failing at runtime, re-run
`nemoclaw onboard` to re-probe the endpoint and bake the correct API path
into the image.
Refer to Switch Inference Models (use the `nemoclaw-user-configure-inference` skill) for details.

## Step 3: Anthropic-Compatible Server

If your local server implements the Anthropic Messages API (`/v1/messages`), choose **Other Anthropic-compatible endpoint** during onboarding instead.

```console
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 644 /sandbox/.openclaw/openclaw.json
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 644 /sandbox/.openclaw/.config-hash
$ cat /tmp/openclaw.updated.json | docker exec -i "$DOCKER_CTR" kubectl exec -i -n openshell "$SANDBOX" -c agent -- sh -c 'cat > /sandbox/.openclaw/openclaw.json'
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- /bin/bash -c "cd /sandbox/.openclaw && sha256sum openclaw.json > .config-hash"
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 444 /sandbox/.openclaw/openclaw.json
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 444 /sandbox/.openclaw/.config-hash
```

Check `/tmp/gateway.log` after upload and confirm the gateway hot-reloaded the provider or `agents.list` change.

## Step 4: Add Sub-Agent Credentials

If the auxiliary model uses a provider key outside the normal NemoClaw inference route, put that key in the sub-agent auth profile.
For the Omni example:

```text
/sandbox/.openclaw-data/agents/vision-operator/agent/auth-profiles.json
```

Use the same provider ID that appears in `models.providers`, such as `nvidia-omni`.
After uploading the auth profile, make sure the sub-agent directory is owned by the sandbox user:

```console
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chown -R sandbox:sandbox /sandbox/.openclaw-data/agents/vision-operator
```

## Step 4: vLLM Auto-Detection (Experimental)

If the sub-agent calls a provider directly, update the OpenShell network policy for the binary that makes the request.
In the Omni demo, the OpenClaw gateway runs as `/usr/local/bin/node`, so the NVIDIA endpoint policy must allow that binary.

Refer to Customize the Network Policy (use the `nemoclaw-user-manage-policy` skill) for policy update workflows.

## Step 6: Add Delegation Instructions

OpenClaw handles `sessions_spawn`, but the primary agent still needs task instructions.
Place those instructions in the writable workspace, for example:

```text
/sandbox/.openclaw-data/workspace/TOOLS.md
```

The Omni demo includes `vlm-demo/vlm-subagent/TOOLS.md`, which tells `main` to delegate image tasks to `vision-operator` and tells the sub-agent to read the image path it receives.
Adapt that file for other task-specific models.

## Step 7: Demo Assets

Use the [`vlm-demo`](https://github.com/brevdev/nemoclaw-demos/tree/main/vlm-demo) repository for runnable Omni example assets:

```console
$ NEMOCLAW_EXPERIMENTAL=1 \
  NEMOCLAW_PROVIDER=vllm \
  nemoclaw onboard --non-interactive
```

NemoClaw auto-detects the model from the running vLLM instance.
To override the model, set `NEMOCLAW_MODEL`.

## Step 5: NVIDIA NIM (Experimental)

NemoClaw can pull, start, and manage a NIM container on hosts with a NIM-capable NVIDIA GPU.

Set the experimental flag and run onboard.

```console
$ NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard
```

Select **Local NVIDIA NIM [experimental]** from the provider list.
NemoClaw filters available models by GPU VRAM, pulls the NIM container image, starts it, and waits for it to become healthy before continuing.

NIM container images are hosted on `nvcr.io` and require NGC registry authentication before `docker pull` succeeds.
If Docker is not already logged in to `nvcr.io`, onboard prompts for an [NGC API key](https://org.ngc.nvidia.com/setup/api-key) and runs `docker login nvcr.io` over `--password-stdin` so the key is never written to disk or shell history.
The prompt masks the key during input and retries once on a bad key before failing.
In non-interactive mode, onboard exits with login instructions if Docker is not already authenticated; run `docker login nvcr.io` yourself, then re-run `nemoclaw onboard --non-interactive`.

> **Note:** NIM uses vLLM internally.
> The same `chat/completions` API path restriction applies.

### Non-Interactive Setup

```console
$ NEMOCLAW_EXPERIMENTAL=1 \
  NEMOCLAW_PROVIDER=nim \
  nemoclaw onboard --non-interactive
```

To select a specific model, set `NEMOCLAW_MODEL`.

## Step 6: Timeout Configuration

Local inference requests use a default timeout of 180 seconds.
Large prompts on hardware such as DGX Spark can exceed shorter timeouts, so NemoClaw sets a higher default for Ollama, vLLM, NIM, and compatible-endpoint setup.

To override the timeout, set the `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` environment variable before onboarding:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ nemoclaw onboard
```

The value is in seconds.
This setting is baked into the sandbox at build time.
Changing it after onboarding requires re-running `nemoclaw onboard`.

## Step 7: Verify the Configuration

After onboarding completes, confirm the active provider and model.

```console
$ nemoclaw <name> status
```

The output shows the provider label (for example, "Local vLLM" or "Other OpenAI-compatible endpoint") and the active model.

## Step 8: Switch Models at Runtime

You can change the model without re-running onboard.
Refer to Switch Inference Models (use the `nemoclaw-user-configure-inference` skill) for the full procedure.

For compatible endpoints, the command is:

```console
$ openshell inference set --provider compatible-endpoint --model <model-name>
```

If the provider itself needs to change (for example, switching from vLLM to a cloud API), rerun `nemoclaw onboard`.

## References

- **Load [references/switch-inference-providers.md](references/switch-inference-providers.md)** when switching inference providers, changing the model runtime, or reconfiguring inference routing. Changes the active inference model without restarting the sandbox.
- **Load [references/set-up-sub-agent.md](references/set-up-sub-agent.md)** when users ask how to add a second model, configure a sub-agent model, use Omni for vision tasks, configure agents.list, or use sessions_spawn in NemoClaw. Shows the NemoClaw-specific file paths and update flow for adding an auxiliary OpenClaw sub-agent model.
- **Load [references/inference-options.md](references/inference-options.md)** when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Lists all inference providers offered during NemoClaw onboarding.

## Related Skills

- Refer to [OpenClaw Sub-Agents](https://docs.openclaw.ai/tools/subagents) for `sessions_spawn`, `agents.list`, nesting, tool policy, and auth behavior.
- `nemoclaw-user-workspace` — Refer to Workspace Files (use the `nemoclaw-user-workspace` skill) to understand per-agent workspace directories
