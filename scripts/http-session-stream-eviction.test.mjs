// 열린 GET 이벤트 스트림이 세션을 영원히 붙잡지 않는가 — 2026-10-16 macmini-1 의
// figma-mcp 가 sessions 106 / sessionMax 64 였다. 퇴출 조건이 「열린 응답 0개」였는데,
// 클라이언트가 사라져도 터널 뒤의 GET 스트림은 닫히지 않아(open>0) 유휴 스윕에서도 상한
// 퇴출에서도 빠졌고, 세션마다 릴레이 소켓을 하나씩 쥐었다.
// ① 스트림을 연 세션은 유휴 한도보다 오래(스트림 한도까지) 살지만 결국 닫히고, 그때
//    스트림도 끝나는지 ② 상한을 넘으면 스트림을 연 세션도 가장 오래 안 쓴 순서로 닫히는지 본다.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const port = 45000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const tempExportDir = mkdtempSync(join(tmpdir(), "talk-to-figma-stream-eviction-"));
const child = spawn(process.execPath, ["dist/server.js", "--http", `--port=${port}`], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    FIGMA_EXPORT_DIR: tempExportDir,
    MCP_SESSION_IDLE_MS: "1500",
    MCP_SESSION_STREAM_IDLE_MS: "4000",
    MCP_SESSION_SWEEP_MS: "100",
    MCP_SESSION_MAX: "2",
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

async function health() {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  return response.json();
}

async function initialize(name) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } },
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const id = response.headers.get("mcp-session-id");
  assert.ok(id);
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": id },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());
  return id;
}

async function listTools(id) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": id },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  await response.text();
  return response.status;
}

// 클라이언트가 열어 두고 다시는 아무것도 보내지 않는 GET 이벤트 스트림.
function openStream(id) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream", "Mcp-Session-Id": id, "MCP-Protocol-Version": "2025-03-26" },
    }, (res) => {
      assert.equal(res.statusCode, 200, "GET 스트림이 열리지 않았다");
      const stream = { ended: false, destroy: () => req.destroy() };
      res.on("data", () => {});
      res.on("end", () => { stream.ended = true; });
      res.on("close", () => { stream.ended = true; });
      resolve(stream);
    });
    req.on("error", reject);
    req.end();
  });
}

const streams = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    if (attempt >= 300) throw new Error(`HTTP server did not become healthy:\n${stderr}`);
    await sleep(100);
  }

  // ① 스트림만 열어 둔 세션 — 유휴 한도(1.5s)는 넘겨도 살아 있고, 스트림 한도(4s)를 넘기면 닫힌다.
  const watcher = await initialize("watcher");
  const watcherStream = await openStream(watcher);
  streams.push(watcherStream);
  await sleep(300);
  const opened = await health();
  assert.equal(opened.sessionsStreaming, 1, "열린 스트림이 /health 에 안 보인다");
  await sleep(2000); // 유휴 한도는 지났고, 스트림 한도 전
  assert.equal((await health()).sessions, 1, "스트림을 연 세션이 유휴 한도에서 너무 일찍 닫혔다");
  await sleep(3000); // 스트림 한도도 지남 — 스트림이 있어도 닫혀야 한다
  const afterStreamIdle = await health();
  assert.equal(afterStreamIdle.sessions, 0, "열린 GET 스트림이 유휴 세션을 붙잡고 있다");
  assert.ok(watcherStream.ended, "세션을 닫았는데 GET 스트림이 끝나지 않았다");
  assert.equal(await listTools(watcher), 404);

  // ② 상한 — 가장 오래 안 쓴 세션이 스트림을 열어 두었어도 셋째 세션이 들어오면 닫힌다.
  const first = await initialize("first");
  streams.push(await openStream(first));
  await sleep(50);
  const second = await initialize("second");
  await sleep(50);
  const third = await initialize("third");
  assert.equal((await health()).sessions, 2, "스트림을 연 세션이 상한 퇴출에서 빠졌다");
  assert.equal(await listTools(first), 404, "상한을 넘었는데 스트림을 연 가장 오래된 세션이 남았다");
  assert.equal(await listTools(second), 200);
  assert.equal(await listTools(third), 200);
  process.stdout.write("Streamable HTTP stream-holding session eviction passed\n");
} catch (error) {
  process.stderr.write(stderr);
  throw error;
} finally {
  for (const stream of streams) stream.destroy();
  child.kill("SIGTERM");
  rmSync(tempExportDir, { recursive: true, force: true });
}
