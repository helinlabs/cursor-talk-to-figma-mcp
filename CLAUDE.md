# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that bridges Cursor AI IDE with Figma. Three components communicate in a pipeline:

```
Cursor AI ←(stdio)→ MCP Server ←(WebSocket)→ WebSocket Relay ←(WebSocket)→ Figma Plugin
```

## Build & Development Commands

```bash
bun install              # Install dependencies
bun run build            # Build MCP server (tsup → dist/)
bun run dev              # Build in watch mode
bun socket               # (dev only) run relay in foreground — prefer the
                         # launchd service via scripts/relayctl.sh (see below)
bun run start            # Run built MCP server
bun setup                # Full setup (install + write .cursor/mcp.json + .mcp.json)
```

There is no test suite or linter configured.

## Running the Relay (launchd service)

The relay is NOT started manually anymore — it runs as a macOS launchd agent
(`com.garen.figma-relay`) that auto-starts at login and auto-restarts on crash.
Manage it with `scripts/relayctl.sh`:

```bash
./scripts/relayctl.sh status     # running? + crash count + recent log
./scripts/relayctl.sh restart    # reload latest src/socket.ts
./scripts/relayctl.sh crashes    # abnormal-exit history (.relay/crash.log)
./scripts/relayctl.sh logs       # follow .relay/relay.log
./scripts/relayctl.sh install    # (re)install the agent + start
./scripts/relayctl.sh stop|start # stop (no auto-restart) / start
```

**IMPORTANT — after editing relay source (`src/socket.ts`), you MUST run
`./scripts/relayctl.sh restart` so the running relay picks up the change**, then
verify with `curl -fsS http://localhost:3055/console` (or `relayctl status`).
The relay runs straight from source via `bun run src/socket.ts`, so there is no
build step — a restart is all that's needed. Do NOT run `bun socket` by hand;
that would collide with the service on port 3055.

Note: this only reloads the **relay**. Editing the MCP server
(`src/talk_to_figma_mcp/server.ts`) requires an `/mcp` reconnect or a new
session to take effect; editing the Figma plugin (`cursor_mcp_plugin/code.js`)
requires re-running the plugin inside Figma.

## Architecture

### MCP Server (`src/talk_to_figma_mcp/server.ts`)
The main server implementing the MCP protocol via `@modelcontextprotocol/sdk`. Exposes 50+ tools (create shapes, modify text, manage layouts, export images, etc.) and several AI prompts (design strategies). Communicates with Cursor over stdio and with the WebSocket relay via `ws`. Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout/promise callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Clients call `join` to enter a channel; messages broadcast only within the same channel.

### Figma Plugin (`src/cursor_mcp_plugin/`)
Runs inside Figma. `code.js` is the plugin main thread handling 30+ commands via a dispatcher. `ui.html` is the plugin UI for WebSocket connection management. `manifest.json` declares permissions (dynamic-page access, localhost network). The plugin is **not built/bundled** — `code.js` is written directly as the runtime artifact.

## Key Patterns

- **Colors**: Figma uses RGBA 0-1 range. The MCP tools accept 0-1 floats and the filter converts to hex for display.
- **Logging**: All logs go to stderr. Stdout is reserved for MCP protocol messages.
- **Timeouts**: 30s default per command. Progress updates from the plugin reset the inactivity timer.
- **Chunking**: Large operations (scanning 100+ nodes) are chunked with progress updates to prevent Figma UI freezing.
- **Reconnection**: WebSocket auto-reconnects after 2 seconds on disconnect.
- **Zod validation**: All tool parameters are validated with Zod schemas.

## Setup

1. Run `bun setup` — installs dependencies and writes MCP config for both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`)
2. `./scripts/relayctl.sh install` — runs the relay as a launchd service (auto-start at login, auto-restart on crash). See "Running the Relay" above.
3. In Figma: Plugins → Development → Link existing plugin → select `src/cursor_mcp_plugin/manifest.json`
4. Run plugin in Figma, join a channel, then use tools from Cursor or Claude Code

The MCP config written by `bun setup` uses the published package:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bunx",
      "args": ["cursor-talk-to-figma-mcp@latest"]
    }
  }
}
```

You can also add it manually for Claude Code via the CLI:

```bash
claude mcp add TalkToFigma -- bunx cursor-talk-to-figma-mcp@latest
```
