---
name: figma-product-mcp
description: Open Gymwork Product and GW Apple Watch design files in separate Figma desktop windows and connect the Talk To Figma MCP development plugin in every window. Use for batch startup or repair of the T, C, GW, CO/Condi, D, F Product, and GW Apple Watch Figma workspace; do not use for unrelated Figma editing.
---

# Figma Product MCP

Run the deterministic macOS launcher first. By default it opens only `GW_Product`, `F_Product`, and `GW_Apple Watch`, separates them into distinct windows, runs `Plugins > Development > Cursor MCP Plugin`, and verifies that each window shows a connected Talk To Figma MCP session.

```bash
"$HOME/.codex/skills/figma-product-mcp/scripts/run.sh"
```

The launcher is idempotent: reuse already-open Product tabs and already-connected plugin panels. A successful run exits `0`. Do not invoke Computer Use when every project reports `connected`.

## Fallback

If the launcher exits nonzero, read [references/fallback.md](references/fallback.md), inspect the final JSON report, and use Computer Use only for projects whose status is not `connected`. Preserve any successful windows and connections. Retry each failed project at most once with Computer Use, then report the remaining blocker instead of looping.

Use `scripts/run.sh --dry-run` for configuration checks that must not operate Figma. Project identifiers live in [scripts/projects.json](scripts/projects.json).

Use `scripts/run.sh --all` only when the user explicitly requests every configured file. Use one or more `--project <id>` arguments when the user names a smaller custom subset.
