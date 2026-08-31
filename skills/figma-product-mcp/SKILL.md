---
name: figma-product-mcp
description: Open Gymwork Product and GW Apple Watch design files in separate Figma desktop windows and connect the Talk To Figma MCP development plugin in every window. Use for batch startup or repair of the T, C, GW, CO/Condi, D, F Product, and GW Apple Watch Figma workspace; do not use for unrelated Figma editing.
---

# Figma Product MCP

Run the deterministic macOS launcher first. It opens the configured files, separates them into distinct windows, runs `Plugins > Development > Cursor MCP Plugin`, and verifies each connection **against the relay**, not against the plugin panel's text.

```bash
"$HOME/.codex/skills/figma-product-mcp/scripts/run.sh"
```

Which files a run targets comes from [scripts/projects.json](scripts/projects.json): `defaultProjectIDs` with no flags, every project with `--all`, or the ones named by repeated `--project <id>`.

The launcher is idempotent, and it settles that from the **relay first**: before any UI is touched, a project the relay reports connected, speaking the relay's own protocol version, and answering from that same file is already everything a run is for — open, in its own window, plugin live on current code. Those projects are reported `connected` without a single accessibility read. A successful run exits `0`.

This ordering is what keeps a run from destroying the state it is checking. When the accessibility tree is unavailable, `projectWindow()` can never find a window, so the old open-first flow re-opened every file's URL on every run and Figma accumulated a window per project per attempt.

## After deploying new plugin code

Figma only re-reads `code.js` when the plugin is **run again**, so a relay/MCP update alone leaves Figma on the old code. The launcher handles this: a window whose plugin reports a different protocol version than the relay counts as stale and is re-run automatically. To re-run every window regardless:

```bash
"$HOME/.codex/skills/figma-product-mcp/scripts/run.sh" --all --force-reconnect
```

Without this, a connected-but-stale window looks healthy and is skipped — which is exactly how a plugin deploy silently fails to land.

`--force-reconnect` drives the Plugins menu, so it needs the renderer accessibility tree. When that tree is down, a project already verified against the relay as connected **and** on the relay's own protocol version keeps its channel and the report says so per project (`forced re-run skipped, no renderer accessibility tree ...`). Nothing is stale in that case, so nothing is lost — but if you actually deployed new plugin code and see that line, the deploy has **not** landed and the re-run must be done by hand.

## Reading a failed run

Every run writes its JSON report to `~/.talk-to-figma/launcher-report.json` (and prints it to stdout, plus stderr when the run failed). Each project carries a `status`, a human `detail`, and — when the plugin handshake gave up — the `step` that gave up:

| `step` | What it means |
|---|---|
| `open_failed` | The file could not be matched to any window. With `renderer_accessibility` as the step this is **not** about the file — see the row below. Without it, the file genuinely did not open before the timeout. |
| `renderer_accessibility` | Figma's renderer accessibility tree never populated, so no tab is visible **and no window can be told apart from another** — unasked, every Figma window answers `AXTitle` `"Figma"`. Figma is Electron and Chromium exposes only the native window shell until an assistive client opts in. The launcher sets `AXManualAccessibility` itself, but on Figma 126.8.16 (Electron/Chrome 148, macOS 26.6.1) that set call **returns `.success` and is then ignored** — measured: 90s of polling, 0 web areas, descendant count frozen at 532/window. `AXEnhancedUserInterface` is rejected outright (`kAXErrorNotImplemented`). So a blanket failure across every project is this, not a tab or file problem, and waiting longer does not fix it. |
| `focus_window` | The project window never became Figma's key window. |
| `plugins_menu_missing` | Figma's menu bar had no **Plugins** menu. Figma rewrites the menu bar per key window and a **file-browser (Recents) window has no Plugins menu at all** — the report's `menuBar` field shows what was there instead. |
| `plugins_menu_press` / `plugin_menu_item_press` | The menu item was found but would not activate. |
| `plugin_menu_item_missing` | `Cursor MCP Plugin` is not under `Plugins > Development` in that window. |
| `renderer_crashed` | The window's Figma renderer had crashed (title and shell intact, but the document replaced by a "Something went wrong" page) and the launcher's Reload click did not bring it back. The launcher repairs this automatically before touching the plugin, so seeing it means the reload itself failed. |
| `connect_timeout` | The plugin ran, but the relay never reported it connected — or it reconnected still speaking the old version, meaning Figma reloaded stale `code.js`. |

Exit codes: `0` everything connected · `1` one or more projects failed (read the report) · `2` usage / config / Accessibility problem · `70` unexpected error.

`--dry-run` touches no UI and doubles as a status report: it lists each configured project with its live plugin version, channel, and whether it is connected, stale, or missing.

## Fallback

If the launcher exits nonzero, read [references/fallback.md](references/fallback.md) and the report's `step`, and use Computer Use only for projects whose status is not `connected`. Retry each failed project at most once, then report the remaining blocker instead of looping.

Use `scripts/run.sh --dry-run` for configuration checks that must not operate Figma.

## Installing / updating on a device

The launcher that runs lives at `~/.codex/skills/figma-product-mcp`, **not** in this repo. Changes here reach a machine only through:

```bash
./scripts/install.sh          # code only; keeps the device's projects.json
./scripts/install.sh --with-config   # also take the repo's projects.json
```

`install.sh` prints a diff when the two `projects.json` files disagree rather than picking a side silently.
