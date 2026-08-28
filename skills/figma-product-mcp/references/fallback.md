# Computer Use fallback

Use this only after `scripts/run.sh` exits nonzero.

1. Read the launcher's JSON report — `~/.talk-to-figma/launcher-report.json`, or the run's stdout. Limit UI repair to entries whose `status` is not `connected`, and let each entry's `step` tell you what to fix (see the table in SKILL.md).
2. `step: plugins_menu_missing` is not a UI-clicking problem: Figma's menu bar follows the key window and a file-browser (Recents) window has no **Plugins** menu. Click into the project's *design* window first, confirm the menu bar shows **Plugins**, and only then run the plugin.
3. Use the Computer Use skill and fresh Figma accessibility state before every action.
4. Open a missing file using its `url` from `scripts/projects.json`.
5. If two configured files share a window, right-click the failed design tab and choose `Move to New Window`. When Figma instead shows `Move to Another Window`, choose its `New Window` submenu item.
6. In that design window, choose `Plugins > Development > Cursor MCP Plugin`.
7. Confirm the connection **against the relay**, not the panel: `curl -s http://127.0.0.1:3055/channels` must list the document with a `figma` client whose `protocolVersion` equals the payload's top-level `protocolVersion`. The panel's `Connected to server in channel:` banner survives a relay restart and says nothing about which `code.js` Figma loaded, and the compact plugin UI hides `Disconnect` entirely — none of it is evidence.
8. Do not close, reload, or reconnect design windows already reported as connected. Retry each failed file once, then stop and report the exact failed file and observed state.

If macOS reports that Accessibility access is missing (launcher exit code `2`), do not attempt UI clicks. Ask the user to enable Accessibility access for the invoking terminal or agent, then rerun the deterministic launcher.

## After the repair: fix the launcher, not just the symptom (2026-08-28)

A fallback run means the deterministic launcher failed at something Computer Use
could do — that gap is a launcher defect until proven otherwise. Once repair is
done (or confirmed unnecessary):

1. Diagnose WHY the primary failed: pair the launcher's JSON report (`status`,
   `detail`, per-entry `step`) with what you actually had to do in the UI.
2. If the cause is fixable in `scripts/figma_product_mcp.swift` /
   `scripts/projects.json` / `run.sh` (wrong menu path, changed window title,
   missing wait, stale selector, config drift), implement the fix in this
   repo's checkout, then **open a PR** — branch + push + PR, never a direct
   push to main. Include the failing report snippet and the repro in the PR
   body. `swiftc -parse` the swift file and `run.sh --dry-run` before pushing.
3. If the cause is environmental (login expired, permission revoked, display
   asleep), do NOT patch the launcher for it — report it as an operational
   finding instead. Only mechanize what is deterministic.
4. One PR per fallback run at most; if a previous fallback PR for the same
   cause is already open, comment on it instead of opening another.
5. Whether or not you opened a PR, end your report with: primary failure cause,
   repair performed, and improvement action taken (PR link or "none — environmental").
