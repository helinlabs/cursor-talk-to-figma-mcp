#!/usr/bin/env node
// Throwaway test client: join a relay channel and send ONE command to the
// live Figma plugin, print the result JSON, exit.
//
//   node scripts/figma-test-client.mjs <channel> <command> '<paramsJson>'
//   node scripts/figma-test-client.mjs <channel> <command> @params.json
//
// `@file` form exists because base64 image payloads blow past the ~1MB argv
// limit (E2BIG) — write the params to a file and pass the path instead.
//
// Used to verify plugin-side features against real nodes without going through
// the MCP tool registration (which only refreshes on a new session).
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const [, , channel, command, paramsJson] = process.argv;
if (!channel || !command) {
  console.error("usage: figma-test-client.mjs <channel> <command> '<paramsJson>'|@params.json");
  process.exit(2);
}
const params = !paramsJson
  ? {}
  : JSON.parse(
      paramsJson.startsWith("@") ? readFileSync(paramsJson.slice(1), "utf8") : paramsJson,
    );
const rid = () => Math.random().toString(36).slice(2);

const ws = new WebSocket("ws://localhost:3055");
let joined = false;
let reqId = null;
const timeout = setTimeout(() => {
  console.error("TIMEOUT (no response in 30s)");
  process.exit(1);
}, 30000);

ws.on("open", () => {
  const id = rid();
  ws.send(JSON.stringify({ id, type: "join", channel, message: { id, command: "join", params: { channel } } }));
});

ws.on("message", (raw) => {
  let data;
  try { data = JSON.parse(raw.toString()); } catch { return; }

  // Join acknowledgement (system message with a result) → now send the command.
  if (!joined && data.type === "system") {
    joined = true;
    reqId = rid();
    ws.send(JSON.stringify({
      id: reqId,
      type: "message",
      channel,
      message: { id: reqId, command, params: { ...params, commandId: reqId } },
    }));
    return;
  }

  if (data.type === "progress_update") return; // ignore progress ticks

  const msg = data.message;
  if (msg && msg.id === reqId) {
    clearTimeout(timeout);
    if (msg.error) {
      console.log(JSON.stringify({ ERROR: msg.error }, null, 2));
      process.exit(0);
    }
    console.log(JSON.stringify(msg.result, null, 2));
    process.exit(0);
  }
});

ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });
