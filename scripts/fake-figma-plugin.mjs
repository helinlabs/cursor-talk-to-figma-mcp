#!/usr/bin/env node
// Stand in for the Figma plugin so the relay and the health watch can be
// exercised without Figma running at all: hello(role=figma) -> join ->
// announce -> heartbeat.
//
//   node scripts/fake-figma-plugin.mjs <channel> <documentName>
//
// It answers no commands on purpose — to the shallow check it is a healthy
// live project, and to the deep check it is a wedged plugin, which is exactly
// the pair of behaviours worth testing.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
const src = readFileSync(new URL("../src/shared/version.ts", import.meta.url), "utf8");
const PROTOCOL_VERSION = /PROTOCOL_VERSION\s*=\s*"([^"]+)"/.exec(src)[1];
const channel = process.argv[2] || "faketest";
const documentName = process.argv[3] || "FakeLive_Product";
const ws = new WebSocket("ws://localhost:3055");
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", role: "figma", requesterId: `fake-${channel}`,
    protocolVersion: PROTOCOL_VERSION, deviceName: "fake", platform: "fake", capabilities: [] }));
  ws.send(JSON.stringify({ type: "join", channel }));
  setTimeout(() => ws.send(JSON.stringify({ type: "announce", channel,
    document: { documentName, fileKey: `fake-${channel}` } })), 300);
});
ws.on("message", (m) => { const d = JSON.parse(m.toString()); if (d.type === "ping") ws.send(JSON.stringify({ type: "pong" })); });
// role=figma sets applicationHeartbeat, so the relay stops counting a client
// that does not send its own heartbeat and drops it out of the live set.
setInterval(() => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "heartbeat", channel }));
}, 5000);
ws.on("error", (e) => { console.error("fake plugin error:", e.message); process.exit(1); });
setTimeout(() => process.exit(0), 600000);
