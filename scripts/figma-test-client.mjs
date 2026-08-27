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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

// 릴레이는 hello(protocolVersion) 없는 클라이언트를 protocol_mismatch 로 끊는다
// (2.x). 버전은 공유 소스에서 읽어 하드코딩 드리프트를 막는다.
const versionSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "shared", "version.ts"),
  "utf8",
);
const PROTOCOL_VERSION = /PROTOCOL_VERSION\s*=\s*"([^"]+)"/.exec(versionSrc)?.[1];
if (!PROTOCOL_VERSION) {
  console.error("cannot read PROTOCOL_VERSION from src/shared/version.ts");
  process.exit(2);
}

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
  // hello 를 먼저 — 릴레이가 hello_ack 를 준 뒤에야 join 이 유효하다.
  ws.send(JSON.stringify({ type: "hello", role: "controller", requesterId: `test-${rid()}`, protocolVersion: PROTOCOL_VERSION }));
});

ws.on("message", (raw) => {
  let data;
  try { data = JSON.parse(raw.toString()); } catch { return; }

  if (data.type === "system" && data.event === "hello_ack") {
    const id = rid();
    ws.send(JSON.stringify({ id, type: "join", channel, message: { id, command: "join", params: { channel } } }));
    return;
  }
  if (data.type === "system" && data.event === "protocol_mismatch") {
    console.error("PROTOCOL MISMATCH:", data.message);
    process.exit(1);
  }

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
ws.on("close", (code, reason) => {
  // 이유 없는 TIMEOUT 으로 오인하지 않게 — 4003 등 종료 사유를 그대로 보인다.
  console.error(`WS closed: ${code} ${reason?.toString() || ""}`);
  process.exit(1);
});
