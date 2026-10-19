// 「busy」로 굳은 세션이 영원히 남지 않는가 — 2026-10-16 18:00 KST macmini-1 의 Figma
// 플러그인 8개가 전부 끊긴 뒤, figma-mcp /health 의 sessionsBusy 1 / oldestIdleSeconds 가
// 벽시계와 1:1 로 자랐다(10-18 146276 → 10-19 232678, +86402s). 유휴 스윕(#73·#74·#76)은
// 「일이 걸린」 세션을 건드리지 않는데, 그 보호에 상한이 없었다.
//
// 가짜 relay 하나(HTTP + WebSocket)를 띄워 세 경로를 본다.
// ① 클라이언트가 notifications/cancelled 를 보낸 요청 — SDK 는 취소된 요청에 응답을 보내지
//    않고, 스트리밍 POST 는 그 응답을 기다리며 닫히지 않았다(inflight 가 0 으로 안 돌아온다).
// ② relay HTTP 가 답하지 않을 때 — relay fetch 에 타임아웃이 없어 도구 호출이 끝나지 않았다.
// ③ 그래도 걸린 세션은 「진행 없음」 상한(MCP_SESSION_BUSY_IDLE_MS)에서 퇴출되고,
//    진행이 오는 정당한 장시간 작업은 같은 상한에서도 살아남는다.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { WebSocketServer } from "ws";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2025-03-26",
};

// --- 가짜 relay -------------------------------------------------------------
// mode "hang": /projects 를 받아 두고 영원히 답하지 않는다(멈춘 relay).
// mode "live": 살아 있는 프로젝트 하나를 보여 주고, 명령마다 progress_update 를
//              progressMs 동안 보낸 뒤 결과를 돌려준다(오래 걸리지만 진행 중인 플러그인).
const relay = { mode: "hang", progressMs: 0, held: [] };
const relayServer = createServer((req, res) => {
  const url = new URL(req.url, "http://relay");
  if (relay.mode === "hang") {
    relay.held.push(res);
    return;
  }
  if (url.pathname === "/projects") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      protocolVersion: null,
      projects: [{ projectKey: "fake-key", name: "Fake_Product", fileKey: "fake-key", connectionCount: 1, recommendedChannel: "fakech" }],
    }));
    return;
  }
  res.writeHead(404).end("{}");
});
const wss = new WebSocketServer({ server: relayServer });
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "join") {
      socket.send(JSON.stringify({ type: "join_result", message: { id: message.id, result: { joined: message.channel } } }));
      return;
    }
    if (message.type !== "message") return;
    const { id, command } = message.message;
    const started = Date.now();
    const tick = setInterval(() => {
      if (socket.readyState !== 1) return clearInterval(tick);
      if (Date.now() - started >= relay.progressMs) {
        clearInterval(tick);
        socket.send(JSON.stringify({ message: { id, result: { pages: [], done: true } } }));
        return;
      }
      socket.send(JSON.stringify({
        type: "progress_update", id,
        message: { data: { commandType: command, progress: 50, message: "working", status: "in_progress" } },
      }));
    }, 250);
  });
});
await new Promise((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
const relayPort = relayServer.address().port;

// --- MCP 서버 ---------------------------------------------------------------
const children = [];
const tempDirs = [];
async function startServer(port, env) {
  const home = mkdtempSync(join(tmpdir(), "talk-to-figma-busy-"));
  tempDirs.push(home);
  const child = spawn(process.execPath, ["dist/server.js", "--http", `--port=${port}`, `--server=http://127.0.0.1:${relayPort}`], {
    stdio: ["ignore", "ignore", "pipe"],
    // HOME 을 바꿔 둬야 선택한 프로젝트가 사용자 ~/.talk-to-figma 에 저장되지 않는다.
    env: { ...process.env, HOME: home, FIGMA_EXPORT_DIR: join(home, "exports"), MCP_SESSION_SWEEP_MS: "100", ...env },
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    if (attempt >= 300) throw new Error(`HTTP server did not become healthy:\n${stderr}`);
    await sleep(100);
  }
  return { base, stderr: () => stderr };
}

async function health(base) {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  return response.json();
}

async function initialize(base) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "busy-test", version: "1" } },
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const id = response.headers.get("mcp-session-id");
  assert.ok(id);
  await post(base, id, { jsonrpc: "2.0", method: "notifications/initialized" });
  return id;
}

async function post(base, session, body) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": session },
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

// 응답 스트림을 끝까지 읽되, 언제 닫혔는지를 따로 알려 주는 tools/call.
function callTool(base, session, id, name, args = {}) {
  let ended = false;
  let body = "";
  const done = new Promise((resolve, reject) => {
    const req = request(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, "Mcp-Session-Id": session },
    }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => { ended = true; resolve(body); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
  });
  done.catch(() => undefined);
  return { done, ended: () => ended, body: () => body };
}

async function within(ms, promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} — ${ms}ms 안에 끝나지 않았다`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

const portBase = 46000 + (process.pid % 1000) * 3;
let current;
try {
  // ① 취소된 요청은 응답 스트림을 닫는다.
  relay.mode = "hang";
  current = await startServer(portBase, {
    FIGMA_RELAY_HTTP_TIMEOUT_MS: "60000",
    MCP_SESSION_BUSY_IDLE_MS: "600000",
  });
  {
    const session = await initialize(current.base);
    const call = callTool(current.base, session, 7, "list_pages");
    await sleep(400);
    const busy = await health(current.base);
    assert.equal(busy.sessionsBusy, 1, "relay 를 기다리는 호출이 있는데 busy 가 아니다");
    assert.equal(busy.busyReasons.inflight, 1);
    assert.equal(call.ended(), false);
    await post(current.base, session, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "client timeout" } });
    await within(2000, call.done, "취소된 요청의 응답 스트림이 닫히지 않았다(inflight 가 영원히 남는다)");
    await sleep(100);
    const after = await health(current.base);
    assert.equal(after.sessionsBusy, 0, `취소 뒤에도 세션이 busy 다: ${JSON.stringify(after)}`);
    assert.equal(after.busyReasons.inflight, 0);
  }

  // ② relay HTTP 가 답하지 않아도 도구 호출은 relay 타임아웃 안에 오류로 끝난다.
  current = await startServer(portBase + 1, {
    FIGMA_RELAY_HTTP_TIMEOUT_MS: "800",
    MCP_SESSION_BUSY_IDLE_MS: "600000",
  });
  {
    const session = await initialize(current.base);
    const call = callTool(current.base, session, 8, "list_pages");
    const body = await within(5000, call.done, "멈춘 relay 를 기다리는 도구 호출이 끝나지 않았다");
    assert.match(body, /relay did not answer/i, `relay 타임아웃 오류가 아니다: ${body}`);
    await sleep(100);
    assert.equal((await health(current.base)).sessionsBusy, 0);
  }

  // ③ 진행 없는 busy 세션은 상한에서 퇴출되고, 진행이 오는 장시간 작업은 살아남는다.
  current = await startServer(portBase + 2, {
    FIGMA_RELAY_HTTP_TIMEOUT_MS: "60000",
    MCP_SESSION_BUSY_IDLE_MS: "1500",
    MCP_SESSION_IDLE_MS: "600000",
  });
  {
    const session = await initialize(current.base);
    const stuck = callTool(current.base, session, 9, "list_pages");
    await sleep(500);
    const busy = await health(current.base);
    assert.equal(busy.sessionsBusy, 1);
    assert.equal(busy.sessionBusyIdleSeconds, 2);
    assert.ok(busy.oldestBusySeconds >= 0);
    assert.equal(busy.oldestIdleSeconds, 0, "busy 세션이 oldestIdleSeconds 에 섞였다");
    await within(4000, stuck.done, "진행 없는 busy 세션이 퇴출되지 않았다");
    await sleep(200);
    const after = await health(current.base);
    assert.equal(after.sessions, 0, `걸린 세션이 남았다: ${JSON.stringify(after)}`);
    assert.equal(after.sessionsEvictedStalled, 1);
    assert.equal(await post(current.base, session, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }), 404);

    // 같은 1.5s 상한에서 4s 동안 진행을 보내는 명령은 끝까지 간다.
    for (const res of relay.held.splice(0)) res.destroy();
    relay.mode = "live";
    relay.progressMs = 4000;
    const working = await initialize(current.base);
    const call = callTool(current.base, working, 11, "list_pages");
    const body = await within(10000, call.done, "진행 중인 장시간 명령이 끝나지 않았다");
    assert.match(body, /done/, `진행 중인 명령이 결과 없이 끊겼다: ${body}`);
    const final = await health(current.base);
    assert.equal(final.sessionsEvictedStalled, 1, "진행 중인 작업이 걸린 세션으로 퇴출됐다");
    assert.equal(final.sessions, 1);
  }
  process.stdout.write("busy session stall handling passed\n");
} catch (error) {
  if (current) process.stderr.write(current.stderr());
  throw error;
} finally {
  for (const child of children) child.kill("SIGTERM");
  for (const res of relay.held) res.destroy();
  wss.close();
  relayServer.close();
  relayServer.closeAllConnections?.();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
