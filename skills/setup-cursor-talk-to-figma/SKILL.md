---
name: setup-cursor-talk-to-figma
description: Install, connect, verify, troubleshoot, and extend the helinlabs/cursor-talk-to-figma-mcp local Figma integration on macOS. Use when setting up a new Mac or PC agent, importing the development plugin into Figma Desktop, diagnosing relay/channel/MCP timeouts, configuring an AI client to use the local source, or adding missing Figma commands and contributing them through a pull request.
---

# Set Up Cursor Talk To Figma

Treat the setup as complete only after a real Figma command succeeds. A running relay or a green plugin badge alone is insufficient.

## Bootstrap the machine

1. Read the repository `AGENTS.md`, `CLAUDE.md`, and `README.md` completely.
2. Require macOS, Bun, and the official Figma Desktop app. Install missing prerequisites from their official sources.
3. Clone `https://github.com/helinlabs/cursor-talk-to-figma-mcp` into a stable development directory. If it already exists, preserve local changes and safely fast-forward the default branch when possible.
4. Run `bun install --frozen-lockfile`, then `bun run build`.
5. Run `./scripts/relayctl.sh install` and `./scripts/relayctl.sh status`. Verify port 3055 and the relay endpoints:

```bash
curl -fsS http://localhost:3055/plugin-version
curl -fsS http://localhost:3055/channels
```

## Link and run the development plugin

Use Figma Desktop, not the web app. Inspect existing development plugins first; remove or replace an older Cursor/Talk to Figma development plugin when it points elsewhere.

Import `src/cursor_mcp_plugin/manifest.json` through **Main menu → Plugins → Development → Import plugin from manifest…**. Run **Cursor MCP Plugin** and connect to port 3055. Keep the plugin window open during MCP work.

If Figma authentication is required, use the account authorized for that machine. Do not invent credentials. A shared-account multi-device warning can immediately invalidate the session; switch to the machine's authorized account and create an editable draft for verification.

## Verify end to end

1. Confirm the plugin window shows the current build hash and a channel ID.
2. Confirm `/channels` lists one Figma client and the expected document.
3. Call a real command through the relay:

```bash
bun scripts/figma-test-client.mjs <channel> get_document_info '{}'
```

4. Configure the AI client to execute the local `src/talk_to_figma_mcp/server.ts` using absolute paths. Preserve existing MCP configuration.
5. In the AI client, call `list_figma_channels`, `join_channel`, and `get_document_info`.
6. Capture the connected plugin state and report the repo path, relay status, build hash, channel, command result, and any remaining limitation.

## Diagnose before retrying

Read [references/troubleshooting.md](references/troubleshooting.md) when setup, channel discovery, or commands fail. Re-read `docs/setup-and-extending.md` before changing the protocol or adding tools, and read `docs/figma-automation-pitfalls.md` before automating design edits.

## Extend the repository when needed

Treat missing commands, unreachable Figma capabilities, repeated timeouts, oversized responses, and inefficient multi-round-trip reads as repository issues—not permanent workarounds.

Before adding a command, search the server command union and the plugin dispatcher. Prefer extending an existing command. Implement the plugin side first, re-run the plugin, and verify it with `figma-test-client.mjs`; then register and validate the MCP server side.

The user authorizes ordinary in-scope fixes and missing specifications in `helinlabs/cursor-talk-to-figma-mcp`, including a focused branch, tests or direct relay verification, documentation, a pull request, and squash merge after checks pass. Preserve unrelated changes, avoid broad refactors, and report the commit and PR. Do not expand external permissions, credentials, or data access without the authorization required by the active safety policy.

## Reuse the one-shot prompt

When provisioning another machine without this skill installed, send the contents of [assets/one-shot-prompt.ko.md](assets/one-shot-prompt.ko.md) as one user prompt.
