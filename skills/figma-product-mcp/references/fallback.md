# Computer Use fallback

Use this only after `scripts/run.sh` exits nonzero.

1. Read the launcher's final JSON report. Limit UI repair to entries whose `status` is not `connected`.
2. Use the Computer Use skill and fresh Figma accessibility state before every action.
3. Open a missing file using its `url` from `scripts/projects.json`.
4. If two configured files share a window, right-click the failed design tab and choose `Move to New Window`. When Figma instead shows `Move to Another Window`, choose its `New Window` submenu item.
5. In that design window, choose `Plugins > Development > Cursor MCP Plugin`.
6. Treat the connection as successful only when the plugin panel contains `Disconnect` and `Connected to server in channel:`. Port `3055` may be shared; each window should have its own channel.
7. Do not close, reload, or reconnect design windows already reported as connected. Retry each failed file once, then stop and report the exact failed file and observed state.

If macOS reports that Accessibility access is missing, do not attempt UI clicks. Ask the user to enable Accessibility access for the invoking terminal or Codex app, then rerun the deterministic launcher.
