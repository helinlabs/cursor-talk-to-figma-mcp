// ---------------------------------------------------------------------------
// Single source of truth for the talk-to-figma protocol version shared by the
// MCP server (src/talk_to_figma_mcp/server.ts) and the relay (src/socket.ts).
//
// The Figma plugin (src/cursor_mcp_plugin/ui.html) cannot import this module —
// the plugin is not built/bundled, ui.html is the runtime artifact — so it
// keeps its own hardcoded copy. That is safe: the relay's hello/join handshake
// compares versions and disconnects any client whose MAJOR differs, with a
// protocol_mismatch message telling the operator to update, so a drifted copy
// is caught at connect time rather than causing silent breakage. When bumping
// the version here, bump ui.html's PROTOCOL_VERSION too.
// ---------------------------------------------------------------------------
export const PROTOCOL_VERSION = "2.3.0";

export function protocolMajor(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) ? major : null;
}
