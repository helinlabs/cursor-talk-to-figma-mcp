# Talk to Figma MCP (local fork)

A Model Context Protocol (MCP) integration between an AI agent (Claude Code, Cursor)
and Figma — it lets the agent read designs and modify them programmatically.

The default setup runs locally, but the relay, MCP server, and Figma plugin are
independent processes and may run on different machines.

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
4. In the plugin window click **Connect**. It defaults to
   `ws://localhost:3055`; enter a reachable `ws://` LAN address or a `wss://`
   remote address when the relay runs on another computer. Give the plugin a
   recognizable device name. The relay groups the
   connection by Figma file/project automatically; random channel ids are now
   internal compatibility details.

The plugin header shows a **build badge**: `build <hash> · loaded HH:MM:SS`. The
hash is a content hash of the on-disk plugin files (fetched from the relay), and
`loaded` is the time it last started — so you can always confirm Figma reloaded
the latest code after an edit.

For a remote relay, expose port 3055 through a firewall/VPN or TLS reverse
proxy, then pass the same endpoint to the MCP server, for example
`--server=wss://relay.example.com/talk-to-figma/`. The web console identifies
connections by device name, local/LAN/external scope, and address. Browsers do
not expose the operating-system hostname, so the plugin device name is an
editable value; the MCP server uses its host name automatically.

The relay itself does not authenticate clients. Do not expose it directly to
the public internet; put it behind an authenticated `wss://` reverse proxy or a
private VPN/network.

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

1. `list_figma_projects` — see connected projects, connection counts, and load.
2. `use_figma_project` with a document name or file key. The relay selects the
   least-loaded healthy plugin connection automatically.
3. Use the tools (see [MCP Tools](#mcp-tools)). If exactly one project is live,
   ordinary tools select it automatically.

## Where to look / what to check

| What | Where |
|---|---|
| **Web console** (channels, device/address identity, running and pending work) | http://localhost:3055/console (or `/`) |
| Channels + documents as JSON | http://localhost:3055/channels |
| Project connections and recommended targets | http://localhost:3055/projects |
| Workload, in-flight requests, and bulk jobs | http://localhost:3055/status |
| Current plugin build hash (matches the plugin badge) | http://localhost:3055/plugin-version |
| Managed export gallery JSON / files | http://localhost:3055/exports |
| Relay health (running? crashes?) | `./scripts/relayctl.sh status` |
| Relay logs / crash history | `./scripts/relayctl.sh logs` · `crashes` · files under `.relay/` |
| Which plugin code Figma loaded | the **build badge** in the plugin window |

## Protocol compatibility

The relay, MCP server, Figma plugin, and dashboard send protocol version
`2.1.0` during their WebSocket handshake. Versions with the same major number
are compatible. A missing or different major version is rejected before join
or command routing with an actionable `protocol_mismatch` message; rebuild or
reconnect the MCP server and re-run the Figma development plugin to update it.

Protocol v2.1 negotiates optional capabilities during the handshake. New v2
peers use binary WebSocket frames for images while older v2 peers keep the
base64 compatibility path. The relay records only transfer metadata, and the
Bun MCP server either writes bytes directly to `outputPath` or converts them to
base64 only for a final inline MCP image response.

During development, backward-compatible features increment the v2 minor/patch
version. Formal release versions and tags are managed separately.

The dashboard starts a live preview only while a viewer has opened a specific
project detail. The default `Figma app window` mode captures a matching on-screen
local macOS Figma window by CoreGraphics window id every two seconds and requires
Screen Recording permission for the relay/Bun process. It still works when the
window is partly covered, but minimized windows are unavailable. `Design node export` uses the connected Figma
plugin instead, works even when the app window is covered, and updates after
selection/document changes. With no viewers, neither capture path runs.

Inline MCP images and live previews are not stored. Pass `saveToGallery: true`
to `export_node_as_image` or `get_current_figma_screenshot` to upload a managed
copy to the relay gallery. The dashboard lists files, thumbnails, count, and
total size and can delete files older than a chosen number of days or delete the
entire gallery. Managed files live under `.relay/exports`, are automatically
deleted after 30 days by default, and can be configured with
`TALK_TO_FIGMA_EXPORT_DIR` and `TALK_TO_FIGMA_EXPORT_RETENTION_DAYS`. Explicit
arbitrary `outputPath` files remain user-managed and are never deleted by the
dashboard.

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
- `list_figma_projects` / `use_figma_project` — project-first discovery and connection
- `get_figma_workload` — plugin/MCP connection counts and queued work
- `get_current_figma_screenshot` — capture the local Figma app window by default, or use `captureMode: "node-export"`
- `list_figma_channels` — list relay channels and which document each is on
- `join_channel` — legacy low-level compatibility tool
- `start_bulk_operations` / `get_bulk_operation` / `cancel_bulk_operation`

### MCP prompts
`design_strategy`, `read_design_strategy`, `text_replacement_strategy`,
`annotation_conversion_strategy`, `swap_overrides_instances`,
`reaction_to_connector_strategy`.

## Best practices

1. Select with `use_figma_project`; channel ids are not needed for normal use.
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
