// 릴레이가 사라진 상대를 걷어내는가 — 핸드셰이크만 하고 그 뒤로 ping 에도 close 에도
// 답하지 않는 클라이언트(전원이 꺼진 맥, 끊긴 터널의 반쪽 연결)를 흉내 낸다.
// heartbeat 타임아웃의 close 가 close 핸드셰이크 응답 없이도 끝나 close 핸들러가
// 돌아야 채널·요청 상태가 풀린다. /health 의 connections 로 확인한다.
// (2026-10-14 figma-mcp 쪽 누수 조사 때 확인: 릴레이 정리는 이미 동작했고, 413개가
// 남은 건 누수된 세션들이 10초마다 heartbeat 를 계속 보내 「살아 있는」 연결이었기 때문.)
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";

const bun = process.env.BUN || "bun";
if (spawnSync(bun, ["--version"]).status !== 0) {
  // 릴레이는 Bun.serve 로만 돈다. CI 의 http 잡에는 bun 이 있다.
  process.stdout.write("relay dead-peer test skipped: bun not found\n");
  process.exit(0);
}

const port = 47000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const workDir = mkdtempSync(join(tmpdir(), "talk-to-figma-relay-dead-peer-"));
const relay = spawn(bun, ["run", join(process.cwd(), "src/socket.ts")], {
  cwd: workDir, // .relay/ 상태 파일을 저장소가 아니라 임시 디렉터리에 쓰게 한다
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_HEARTBEAT_INTERVAL_MS: "300",
    RELAY_HEARTBEAT_TIMEOUT_MS: "1500",
  },
});
let output = "";
relay.stdout.on("data", (chunk) => { output += chunk.toString(); });
relay.stderr.on("data", (chunk) => { output += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connections() {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  return (await response.json()).connections;
}

// 업그레이드 응답(101)을 받은 뒤로는 아무것도 읽지도 쓰지도 않는 소켓.
function silentPeer() {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        "", "",
      ].join("\r\n"));
    });
    socket.once("data", (chunk) => {
      if (!chunk.toString().startsWith("HTTP/1.1 101")) reject(new Error(`upgrade failed: ${chunk}`));
      socket.pause(); // 이후 프레임(ping·close)은 읽지 않는다 — 답하지 않는 상대
      resolve(socket);
    });
    socket.on("error", () => undefined);
  });
}

const peers = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    if (attempt >= 300) throw new Error(`relay did not become healthy:\n${output}`);
    await sleep(100);
  }

  peers.push(await silentPeer(), await silentPeer());
  await sleep(200);
  assert.equal((await connections()).total, 2, "말 없는 상대 둘이 붙어 있어야 한다");

  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await connections();
    if (last.total === 0) break;
    await sleep(100);
  }
  assert.equal(last.total, 0, `응답 없는 상대가 걷히지 않았다: ${JSON.stringify(last)}`);
  process.stdout.write("Relay dead-peer cleanup passed\n");
} catch (error) {
  process.stderr.write(output);
  throw error;
} finally {
  for (const peer of peers) peer.destroy();
  relay.kill("SIGTERM");
  await sleep(100);
  rmSync(workDir, { recursive: true, force: true });
}
