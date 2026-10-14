// 세션이 끝나면 그 세션의 릴레이 WebSocket 도 닫히는가 — 2026-10-14 macmini-1 에서
// figma-mcp 가 sessions 21 · sessionsEvicted 392 인데 릴레이(:3055)로 ESTABLISHED
// 413개를 쥐고 있었다. #73 의 유휴 만료가 MCP transport 만 닫고, 정리 핸들러는
// McpServer.connect() 가 transport.onclose 를 덮어써서 한 번도 불리지 않았다.
// 가짜 릴레이로 「실제로 열린 연결 수」를 세며 세션이 끝나는 네 경로를 모두 본다:
// ① 클라이언트 DELETE ② 세션 상한 초과 ③ 거부된 initialize ④ 유휴 만료.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const relayPort = 45000 + (process.pid % 1000);
const port = 46000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const tempExportDir = mkdtempSync(join(tmpdir(), "talk-to-figma-relay-release-"));

// 릴레이 쪽에서 본 열린 연결 — 서버의 자기 보고(/health)와 별개로 센다.
const relay = new WebSocketServer({ host: "127.0.0.1", port: relayPort });
let relayOpen = 0;
relay.on("connection", (socket) => {
  relayOpen++;
  socket.on("close", () => { relayOpen--; });
  socket.on("error", () => undefined);
});
await new Promise((resolve) => relay.once("listening", resolve));

const child = spawn(process.execPath, ["dist/server.js", "--http", `--port=${port}`, `--server=ws://127.0.0.1:${relayPort}`], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    FIGMA_EXPORT_DIR: tempExportDir,
    MCP_SESSION_IDLE_MS: "4000",
    MCP_SESSION_SWEEP_MS: "100",
    MCP_SESSION_MAX: "4",
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2025-03-26",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const initializeBody = (name) => JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } },
});

async function health() {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  return response.json();
}

async function initialize(name) {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: initializeBody(name) });
  assert.equal(response.status, 200);
  await response.text();
  const id = response.headers.get("mcp-session-id");
  assert.ok(id);
  return id;
}

// 소켓은 비동기로 열리고 닫힌다 — 기대값에 닿을 때까지 기다리고, 끝내 안 닿으면 실패.
async function settle(expected, label) {
  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    const h = await health();
    last = { relayOpen, relaySockets: h.relaySockets, relaySocketsOpen: h.relaySocketsOpen, sessions: h.sessions };
    if (relayOpen === expected && h.relaySockets === expected && h.relaySocketsOpen === expected) return h;
    await sleep(50);
  }
  assert.fail(`${label}: 릴레이 연결 ${expected}개를 기대했는데 ${JSON.stringify(last)}`);
}

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    if (attempt >= 300) throw new Error(`HTTP server did not become healthy:\n${stderr}`);
    await sleep(100);
  }

  const a = await initialize("a");
  await initialize("b");
  await initialize("c");
  let h = await settle(3, "세션 3개 생성");
  assert.equal(h.sessions, 3);

  // ① DELETE — 클라이언트가 세션을 닫으면 그 세션의 소켓도 닫힌다.
  const deleted = await fetch(`${base}/mcp`, { method: "DELETE", headers: { ...headers, "Mcp-Session-Id": a } });
  assert.equal(deleted.status, 200);
  h = await settle(2, "DELETE 뒤");
  assert.equal(h.sessions, 2);

  // ② 상한 — 넷째까지는 받고, 다섯째가 들어오면 가장 오래 안 쓴 세션과 소켓이 함께 나간다.
  await initialize("d");
  await initialize("e");
  await settle(4, "상한까지 채움");
  await initialize("f");
  h = await settle(4, "상한 초과로 하나 축출");
  assert.equal(h.sessions, 4);
  assert.ok(h.sessionsEvicted >= 1);

  // ③ 거부된 initialize — 세션 id 가 발급되지 않았으니 미리 연 소켓을 닫아야 한다.
  const rejected = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: initializeBody("rejected"),
  });
  assert.equal(rejected.status, 406);
  await rejected.text();
  await sleep(300);
  h = await settle(4, "거부된 initialize 뒤");
  assert.equal(h.sessions, 4);
  assert.equal(h.sessionsEvicted, 1, "거부된 initialize 가 살아 있는 세션을 상한 축출로 내보냈다");

  // ④ 유휴 만료 — 남은 세션이 모두 만료되면 릴레이 연결도 0 이 된다.
  await sleep(4500);
  h = await settle(0, "유휴 만료 뒤");
  assert.equal(h.sessions, 0);
  assert.ok(h.sessionsEvicted >= 5, `만료 집계가 모자란다: ${h.sessionsEvicted}`);
  process.stdout.write("Relay sockets released with their MCP sessions passed\n");
} catch (error) {
  process.stderr.write(stderr);
  throw error;
} finally {
  child.kill("SIGTERM");
  relay.close();
  for (const socket of relay.clients) socket.terminate();
  rmSync(tempExportDir, { recursive: true, force: true });
}
