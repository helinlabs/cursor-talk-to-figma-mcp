# Talk to Figma MCP (local fork)

A Model Context Protocol (MCP) integration between an AI agent (Claude Code, Cursor)
and Figma — it lets the agent read designs and modify them programmatically.

This fork is run **entirely locally** (no published package, no deployment). The
sections below are the first-run guide for a fresh machine.

## Architecture

Four pieces talk in a pipeline:

```
AI agent ⇄(stdio)⇄ MCP server ⇄(WebSocket)⇄ Relay (:3055) ⇄(WebSocket)⇄ Figma plugin
```

| Piece | Where | Role |
|---|---|---|
| **MCP server** | `src/talk_to_figma_mcp/server.ts` | Exposes ~50 tools to the AI agent over stdio; talks to the relay. Has filesystem access (e.g. saves exported images). One process **per AI session**. |
| **Relay** | `src/socket.ts` (port 3055) | Routes messages between MCP server and plugin by channel. Also serves a web console. Runs as a background service (launchd). |
| **Figma plugin** | `src/cursor_mcp_plugin/` | Runs inside Figma (`code.js` + `ui.html`). Has Figma API access, no filesystem. Not bundled — the source files are the runtime. |
| **Web console** | served by the relay at `/console` | Live view of channels, documents, and requests. |

> macOS-only as written: the relay is installed as a launchd LaunchAgent.

## First-time setup

### 0. Prerequisites

- **Bun** — `curl -fsSL https://bun.sh/install | bash`
- **Figma desktop app**

### 1. Install dependencies

```bash
bun install
```

### 2. Start the relay as a background service

```bash
./scripts/relayctl.sh install     # registers a launchd agent and starts it
./scripts/relayctl.sh status      # 🟢 running (pid …) — http://localhost:3055/console
```

The relay now **auto-starts at login** and **auto-restarts if it crashes** — you
never have to keep a terminal open for it. It runs `bun run src/socket.ts` on
port 3055.

Control it any time with `./scripts/relayctl.sh <cmd>`:

| Command | What it does |
|---|---|
| `status` | running? + crash count + recent log |
| `restart` | reload after editing `src/socket.ts` |
| `stop` / `start` | stop (won't auto-restart) / start |
| `logs` | follow `.relay/relay.log` |
| `crashes` | list abnormal exits (timestamps + reason) |
| `uninstall` | remove the launchd agent |

> Prefer a foreground/dev run instead? `bun socket` works too — but don't run it
> while the service is up (both would fight for port 3055).

### 3. Link the Figma plugin

1. Figma → **Plugins → Development → Import plugin from manifest…**
2. Select `src/cursor_mcp_plugin/manifest.json`.
3. Run it: **Plugins → Development → Talk To Figma MCP Plugin**.
4. In the plugin window click **Connect** (port 3055). It joins a random channel
   whose name is shown in the UI — you'll need that name to join from the agent.

The plugin header shows a **build badge**: `build <hash> · loaded HH:MM:SS`. The
hash is a content hash of the on-disk plugin files (fetched from the relay), and
`loaded` is the time it last started — so you can always confirm Figma reloaded
the latest code after an edit.

### 4. Point your AI client at the local MCP server

This fork runs the MCP server **straight from source** (no build step). Configure
your client with **absolute paths**.

**Claude Code** — one-liner (run from the repo root):

```bash
claude mcp add TalkToFigma -- "$(which bun)" "$(pwd)/src/talk_to_figma_mcp/server.ts"
```

…or edit a project `.mcp.json` / `~/.cursor/mcp.json` directly:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/repo/src/talk_to_figma_mcp/server.ts"]
    }
  }
}
```

> **Important:** each AI session spawns its **own** MCP server process, and that
> process reads `server.ts` **once at spawn**. After you edit `server.ts`,
> reconnect (`/mcp` → reconnect, or start a new session) so the change is picked
> up — there is no hot reload. See the workflow table below.

### 5. Connect and use

In the AI client:

1. `list_figma_channels` — find the channel whose document matches your Figma file.
2. `join_channel` with that channel name.
3. Use the tools (see [MCP Tools](#mcp-tools)).

## Where to look / what to check

| What | Where |
|---|---|
| **Web console** (channels, documents, live request explorer) | http://localhost:3055/console (or `/`) |
| Channels + documents as JSON | http://localhost:3055/channels |
| Current plugin build hash (matches the plugin badge) | http://localhost:3055/plugin-version |
| Relay health (running? crashes?) | `./scripts/relayctl.sh status` |
| Relay logs / crash history | `./scripts/relayctl.sh logs` · `crashes` · files under `.relay/` |
| Which plugin code Figma loaded | the **build badge** in the plugin window |

## Editing — what makes a change take effect

There is no build step for any piece; each just needs the right reload:

| You edit… | To apply it |
|---|---|
| `src/socket.ts` (relay) | `./scripts/relayctl.sh restart` |
| `src/cursor_mcp_plugin/code.js` or `ui.html` (plugin) | Re-run the plugin in Figma (the badge hash changes) |
| `src/talk_to_figma_mcp/server.ts` (MCP server) | Reconnect MCP in the agent (`/mcp`) or start a new session |

A handy throwaway tester that talks to the live plugin over the relay without
going through an AI session:

```bash
bun scripts/figma-test-client.mjs <channel> <command> '<paramsJson>'
# e.g.
bun scripts/figma-test-client.mjs abc12345 get_document_info '{}'
```

## MCP Tools

### Document, selection & navigation
- `get_document_info` — current page info + child list (image-fill nodes flagged with `hasImageFill`)
- `get_selection` / `read_my_design` — current selection
- `get_node_info` / `get_nodes_info` — node detail; supports `fields`/`maxDepth` shaping and `includeHash` (a stable `subtreeHash` for change detection). Image-fill nodes carry `hasImageFill`.
- `get_frame_context` — **one-shot, RN-ready digest of a screen subtree**: OS chrome + hidden nodes dropped; each node carries relative bounds, text + typography, flex layout, resolved semantic tokens, and `hasImageFill`. Replaces several round-trips.
- `list_pages` / `set_current_page` / `get_node_by_key` / `diagnose_pages`
- `set_focus` / `set_selections`

### Design-system / tokens
- `get_design_system_info` — components, styles, variables (with keys)
- `get_nodes_design_info` — per-node provenance (which component / variable / style each node references)
- `scan_design_usage` — design-system usage analysis

### Export
- `export_node_as_image` — export a node as **PNG / JPG / SVG / PDF**.
  - `outputPath` → the bytes are **saved to that file** (parent dirs auto-created) and the tool returns `{ path, nodeName, width, height, bytes }` — no inline base64 to wrangle.
  - SVG always carries **real, renderable colors**. Pass `includeColorTokens: true` to also get `colorTokens` (`[{ token, hex, property }]`, document order) — the authoritative list of which color variable each paint is bound to, so the caller can inject its own `{{token}}` placeholders. (The plugin never mutates the SVG.)

### Creating & modifying
- `create_rectangle` / `create_frame` / `create_text`
- `scan_text_nodes` / `set_text_content` / `set_multiple_text_contents`
- `set_layout_mode` / `set_padding` / `set_axis_align` / `set_layout_sizing` / `set_item_spacing`
- `set_fill_color` / `set_stroke_color` / `set_corner_radius`
- `move_node` / `resize_node` / `delete_node` / `delete_multiple_nodes` / `clone_node`

### Components
- `get_styles` / `get_local_components` / `create_component_instance`
- `get_instance_overrides` / `set_instance_overrides`

### Annotations & prototyping
- `get_annotations` / `set_annotation` / `set_multiple_annotations` / `scan_nodes_by_types`
- `get_reactions` / `set_default_connector` / `create_connections`

### Connection management
- `list_figma_channels` — list relay channels and which document each is on
- `join_channel` — join a channel to talk to a specific Figma file

### MCP prompts
`design_strategy`, `read_design_strategy`, `text_replacement_strategy`,
`annotation_conversion_strategy`, `swap_overrides_instances`,
`reaction_to_connector_strategy`.

## Best practices

1. Always `join_channel` before sending commands (`list_figma_channels` finds it).
2. Start from `get_document_info`; for a whole screen prefer `get_frame_context`.
3. Verify changes with `get_node_info` / `read_my_design`.
4. For large designs, rely on the chunked/progress-reporting tools
   (`scan_text_nodes`, `get_frame_context`) and watch the web console.
5. Use `includeHash` to detect which screens changed between runs.

## Credits

Built on [sonnylazuardi/cursor-talk-to-figma-mcp](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp).
Bulk text replacement and instance-override propagation contributed by
[@dusskapark](https://github.com/dusskapark)
([text demo](https://www.youtube.com/watch?v=j05gGT3xfCs) ·
[overrides demo](https://youtu.be/uvuT8LByroI)).

## License

MIT
