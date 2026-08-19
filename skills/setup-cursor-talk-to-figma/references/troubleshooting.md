# Troubleshooting

## Quick diagnosis

| Symptom | Check | Resolution |
|---|---|---|
| Figma has no Development menu | The active file is view-only or the browser app is open | Use Figma Desktop and create/open an editable design file |
| Plugin does not appear | Development plugin path | Re-import the absolute `src/cursor_mcp_plugin/manifest.json` path |
| Plugin says it cannot connect | `./scripts/relayctl.sh status`, port 3055 | Install/restart the relay; do not also run `bun socket` |
| `/channels` is empty | Plugin window and connection state | Run the plugin, click Connect, and keep its window open |
| Command times out | Current channel ID | Re-read `/channels`; the channel changes whenever the plugin restarts |
| UI shows connected but commands fail | Direct relay command | Run `figma-test-client.mjs`; distinguish plugin/relay failure from AI-client MCP configuration |
| New plugin command works directly but not in the agent | MCP server process age | Reconnect the MCP server or start a new session |
| Relay source edit has no effect | Running launchd process | Run `./scripts/relayctl.sh restart` |
| Plugin source edit has no effect | Build badge | Re-run the plugin and confirm the hash changed |
| Bun install dirties `bun.lock` | Bun lockfile migration | Prefer `--frozen-lockfile`; do not commit an incidental lockfile-format change |
| Figma signs out immediately | Shared-account multi-device policy | Sign in with the account authorized for that machine |

## Layer isolation

Verify the pipeline from the middle outward:

1. Relay: `relayctl status`, `/plugin-version`, `/channels`.
2. Plugin: current build hash, channel, document metadata.
3. Direct command: `figma-test-client.mjs`.
4. MCP server: local absolute source path and a fresh process.
5. Agent: `list_figma_channels` → `join_channel` → `get_document_info`.

Never diagnose an end-to-end timeout by repeatedly restarting every layer. Find the first failing boundary.

## Contribution checks

- Plugin command exists in its dispatcher and returns structured errors.
- Direct relay test covers the real Figma behavior.
- Server command/type/schema matches the plugin payload end to end.
- `bun run build` succeeds.
- Relay edits are restarted and plugin edits are re-run.
- `docs/figma-automation-pitfalls.md` records a newly discovered non-obvious constraint.
- The pull request is focused and squash-merged only after validation.
