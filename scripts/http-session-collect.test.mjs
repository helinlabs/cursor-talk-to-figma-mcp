// 닫힌 세션이 실제로 메모리에서 빠지는가 — 2026-11-04 10:40 부터 macmini-1 의
// figma-mcp 가 세션 18~24개·busy 0·relaySockets = sessions 인데 footprintMB 128 →
// 1849 로 하루 만에 자랐다. 퇴출 세션 1개당 약 1.8MB(세션의 McpServer 하나 크기)씩,
// 도구 호출이 0건인 밤에도. 스왑 31.9/32GB·메모리 압력 warn 상태에서 힙이 통째로
// 스왑에 나가 있었고(rssMB 64) 회수가 멈췄다 — 같은 Bun 으로 로컬에서는 몇 초 안에
// 회수된다. 그래서 서버가 활동 뒤 full GC 를 직접 돌리고, /health 가 「닫혔는데 아직
// 메모리에 있는 세션」 수를 보고한다. 여기서 보는 것:
// ① 세션을 만들고 버리면 sessionsClosed 가 늘고, 다음 GC 뒤 sessionsUncollected 가
//    0 근처로 돌아오는가(돌아오지 않으면 진짜 참조가 남은 것 — 그게 누수다)
// ② 클라이언트가 사라진 이벤트 스트림 뒤에 다시 GET 하면 409 가 아니라 새 스트림을
//    받는가(Bun 1.3 은 끊긴 응답에 close 를 안 보내 SDK 가 옛 스트림을 계속 쥐었다)
//
// 서버 런타임: node(--expose-gc, dist) 한 번, PATH 에 bun 이 있으면 운영과 같은
// `bun src/talk_to_figma_mcp/server.ts` 로 한 번 더.
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

const runtimes = [{ label: "node", command: process.execPath, args: ["--expose-gc", "dist/server.js"] }];
if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0) {
  runtimes.push({ label: "bun", command: "bun", args: ["src/talk_to_figma_mcp/server.ts"] });
}

for (const [index, runtime] of runtimes.entries()) {
  const port = 47000 + (process.pid % 900) + index;
  const base = `http://127.0.0.1:${port}`;
  const tempExportDir = mkdtempSync(join(tmpdir(), "talk-to-figma-collect-"));
  const child = spawn(runtime.command, [...runtime.args, "--http", `--port=${port}`, "--server=ws://127.0.0.1:9"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      FIGMA_EXPORT_DIR: tempExportDir,
      MCP_SESSION_IDLE_MS: "1000",
      MCP_SESSION_SWEEP_MS: "100",
      MCP_GC_INTERVAL_MS: "500",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const health = async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (sessionId, body) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId, "MCP-Protocol-Version": "2025-06-18" } : {}) },
      body: JSON.stringify(body),
    });
    await response.text();
    return response;
  };
  const initialize = async (name) => {
    const response = await post(null, {
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } },
    });
    assert.equal(response.status, 200);
    const id = response.headers.get("mcp-session-id");
    assert.ok(id);
    return id;
  };
  // A raw GET, so the test decides how the client goes away: it reads the
  // status line and then drops the connection without a word.
  const openStreamAndVanish = (sessionId) => new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("data", (chunk) => {
      resolve(chunk.toString().split("\r\n")[0]);
      socket.destroy();
    });
    socket.write(`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n`
      + `mcp-session-id: ${sessionId}\r\nMCP-Protocol-Version: 2025-06-18\r\n\r\n`);
  });

  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await health(); break; } catch { await sleep(100); }
    }
    const before = await health();
    assert.equal(before.gc.available, true, `${runtime.label}: a full collection must be available`);
    assert.equal(before.sessionsCreated, 0);

    // ② the event stream can be reopened after its client vanished
    const streamSession = await initialize("stream");
    await post(streamSession, { jsonrpc: "2.0", method: "notifications/initialized" });
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(await openStreamAndVanish(streamSession), "HTTP/1.1 200 OK",
        `${runtime.label}: reopening the event stream (attempt ${attempt + 1}) must not be refused`);
      await sleep(100);
    }

    // ① closed sessions leave memory
    const churn = 20;
    for (let i = 0; i < churn; i++) {
      const id = await initialize(`churn-${i}`);
      assert.equal((await post(id, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 200);
    }
    let last;
    for (let attempt = 0; attempt < 80; attempt++) {
      await sleep(100);
      last = await health();
      if (last.sessions === 0 && last.sessionsClosed === churn + 1 && last.gc.runs > 0 && last.sessionsUncollected <= 1) break;
    }
    assert.equal(last.sessions, 0, `${runtime.label}: every session should have idled out: ${JSON.stringify(last)}`);
    assert.equal(last.sessionsCreated, churn + 1);
    assert.equal(last.sessionsClosed, churn + 1);
    assert.ok(last.gc.runs > 0, `${runtime.label}: the server should have run a collection: ${JSON.stringify(last.gc)}`);
    assert.ok(last.sessionsUncollected <= 1,
      `${runtime.label}: closed sessions are still in memory after collecting: ${JSON.stringify(last)}`);
    console.log(`${runtime.label}: stream reopen ok; ${last.sessionsClosed} sessions closed, `
      + `${last.sessionsUncollected} uncollected after ${last.gc.runs} gc run(s) (heap ${last.gc.heapMBBefore} → ${last.gc.heapMBAfter} MB)`);
  } catch (error) {
    console.error(stderr.slice(-4000));
    throw error;
  } finally {
    child.kill();
    rmSync(tempExportDir, { recursive: true, force: true });
  }
}
console.log("http-session-collect: ok");
