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

## 다른 프로젝트에서 붙일 때 · 도구가 부족할 때

[docs/setup-and-extending.md](docs/setup-and-extending.md) — **로컬 소스를 가리키는 `.mcp.json`
설정**(npm 배포판에는 여기서 추가한 명령이 없다)과, 쓰다가 막혔을 때 **직접 명령을 추가하는
절차**가 있다.

이 MCP 는 우리가 쓰려고 우리가 들고 있는 도구다. **스펙에 도달할 수 없거나, 탐색이
비효율적이거나, 타임아웃·상한에 자꾸 걸리면 우회하지 말고 고친다.** 플러그인에 먼저 넣고
`scripts/figma-test-client.mjs` 로 실동작을 확인한 뒤 서버에 등록하면, 새 세션을 열지 않고도
그 자리에서 쓸 수 있다.

## 디자인 파일을 자동으로 고칠 때 (필독)

**쓰기 도구는 아무 일도 안 일어나도 성공을 응답한다.** 가려진 사본을 건드렸거나, 오토레이아웃에
좌표를 썼거나, 자식이 부모와 같은 폭이면 전부 "성공"이다. 그래서 **한 번에 여러 개를 적용하지
말고 적용 → 재조회 → 확인을 반복**한다. 실제로 21개를 몰아 적용했다가 어느 게 먹었는지 몰라
전부 되돌린 적이 있다.

밟았던 함정 전체는 [docs/figma-automation-pitfalls.md](docs/figma-automation-pitfalls.md) 에
있다. 디자인 파일을 스크립트로 고치기 전에 읽을 것. 요약:

- 같은 좌표에 **가려진 사본**이 여러 벌 쌓여 있다. 이름이 아니라 "바꿨을 때 렌더가 변하는가" 로 찾는다
- 가로 오토레이아웃은 좌표가 아니라 **자식 순서**다. 넘치는 행은 정렬·폭까지 같이 바꿔야 한다
- **인스턴스 내부는 순서도 좌표도 못 바꾼다** → `detach_instance`
- 중첩 컨테이너를 둘 다 뒤집으면 안쪽이 두 번 뒤집힌다 → **최상위만**
- `clone_node` 에 `parentId` 를 주면 **x/y 가 부모 기준 상대좌표**다
- `characters` 대입은 구간별 폰트 크기를 뭉갠다 → `get/set_text_segments`
- export 가 1×1 이면 노드가 **다른 프레임 안으로 들어가 클리핑**된 것이다

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
