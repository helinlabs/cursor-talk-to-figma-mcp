// 버려진 Streamable HTTP 세션이 영원히 남지 않는가 — 2026-10-13 macmini-1 에서
// figma-mcp 가 닫히지 않은 세션 3,888개(세션마다 릴레이 WebSocket 1개)로 8.7GB 를
// 쥐고 있었다. 짧은 유휴 만료·상한으로 띄워 ① 유휴 세션이 만료되면 404(재-initialize
// 신호)가 오고 ② 상한을 넘으면 가장 오래 안 쓴 세션부터 닫히는지 본다.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 44000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const tempExportDir = mkdtempSync(join(tmpdir(), "talk-to-figma-eviction-"));
const child = spawn(process.execPath, ["dist/server.js", "--http", `--port=${port}`], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    FIGMA_EXPORT_DIR: tempExportDir,
    MCP_SESSION_IDLE_MS: "2000",
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

try {
  // 콜드 기동이 몇 초 걸리는 머신이 있다(번들 import) — 넉넉히 기다린다.
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    if (attempt >= 300) throw new Error(`HTTP server did not become healthy:\n${stderr}`);
    await sleep(100);
  }

  // ① 유휴 만료 — 쓰는 동안은 살아 있고, 손을 떼면 닫힌다.
  const idle = await initialize("idle");
  assert.equal((await health()).sessions, 1);
  await sleep(300);
  assert.equal(await listTools(idle), 200, "만료 전에는 세션이 살아 있어야 한다");
  await sleep(3500);
  assert.equal(await listTools(idle), 404, "유휴 세션이 만료되지 않았다");
  const afterIdle = await health();
  assert.equal(afterIdle.sessions, 0);
  assert.ok(afterIdle.sessionsEvicted >= 1);
  assert.equal(typeof afterIdle.rssMB, "number");

  // ② 상한 — 셋째 세션이 들어오면 가장 오래 안 쓴 첫째가 닫힌다.
  const first = await initialize("first");
  await sleep(50);
  const second = await initialize("second");
  await sleep(50);
  const third = await initialize("third");
  assert.equal((await health()).sessions, 2);
  assert.equal(await listTools(first), 404, "상한을 넘었는데 가장 오래된 세션이 남았다");
  assert.equal(await listTools(second), 200);
  assert.equal(await listTools(third), 200);
  process.stdout.write("Streamable HTTP session eviction passed\n");
} catch (error) {
  process.stderr.write(stderr);
  throw error;
} finally {
  child.kill("SIGTERM");
  rmSync(tempExportDir, { recursive: true, force: true });
}
