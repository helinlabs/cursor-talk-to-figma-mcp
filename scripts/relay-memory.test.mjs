// 릴레이 메모리 — 2026-10-16 macmini-1 의 릴레이가 연결 ~115개에 footprint 2GB 였다.
// 연결별 상태는 원인이 아니었다(scripts/relay-churn-repro.mjs: 연결 1,600개·명령 4,800개
// 뒤에도 70MB). 원인은 프로젝트 인덱스 JSON 의 통파싱이었다 — /index/status 한 번에
// 인덱스 115MB 를 전부 JSON.parse 해 ~1GB 가 일시로 잡히고, Bun 은 전체 GC 전까지 그
// 페이지를 OS 에 돌려주지 않았다.
// ① /index/status 가 사이드카 요약을 쓰는지(인덱스 파일을 다시 파싱하지 않는지)
// ② 무거운 인덱스 경로 뒤에 힙 반환(Bun.gc)이 도는지
// ③ /health 가 다음 측정에 필요한 memory·state 를 내놓는지
// ④ 읽기를 멈춘 콘솔(monitor)이 송신 버퍼를 쥔 채 남지 않는지 본다.
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";

const bun = process.env.BUN || "bun";
if (spawnSync(bun, ["--version"]).status !== 0) {
  process.stdout.write("relay memory test skipped: bun not found\n");
  process.exit(0);
}

const PROTOCOL_VERSION = readFileSync("src/shared/version.ts", "utf8").match(/PROTOCOL_VERSION = "([^"]+)"/)[1];
const port = 46000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), "talk-to-figma-relay-memory-"));
const indexDir = join(home, ".talk-to-figma", "index");
mkdirSync(indexDir, { recursive: true });
// 사이드카가 없던 시절의 인덱스 파일 — 첫 목록에서 한 번 파싱되고 사이드카가 생겨야 한다.
const indexFile = join(indexDir, "project-Legacy.json");
writeFileSync(indexFile, JSON.stringify({
  projectKey: "Legacy", projectName: "Legacy", builtAt: 1, updatedAt: 2, pageCount: 1, nodeCount: 3,
  pages: [{ pageId: "0:1", pageName: "P", builtAt: 1, nodeCount: 3, entries: [] }],
}));

const relay = spawn(bun, ["run", join(process.cwd(), "src/socket.ts")], {
  cwd: home,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HOME: home,
    PORT: String(port),
    RELAY_HEARTBEAT_INTERVAL_MS: "300",
    RELAY_HEAP_RELEASE_DELAY_MS: "200",
    RELAY_MONITOR_BACKLOG_LIMIT_BYTES: String(256 * 1024),
  },
});
let output = "";
relay.stdout.on("data", (chunk) => { output += chunk.toString(); });
relay.stderr.on("data", (chunk) => { output += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function health() {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  return response.json();
}

function open() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitFor(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    socket.on("message", function onMessage(raw) {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(data);
    });
  });
}

// 업그레이드하고 {"type":"monitor"} 한 프레임만 보낸 뒤 읽기를 멈추는 콘솔.
function stalledMonitor() {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([
        "GET / HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`, "Sec-WebSocket-Version: 13", "", "",
      ].join("\r\n"));
    });
    socket.on("error", () => {});
    socket.once("data", () => {
      const body = Buffer.from(JSON.stringify({ type: "monitor" }));
      const mask = randomBytes(4);
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, Buffer.from(body.map((b, i) => b ^ mask[i % 4]))]));
      socket.pause();
      resolve(socket);
    });
    setTimeout(() => reject(new Error("monitor upgrade timeout")), 5000);
  });
}

const sockets = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    if (attempt >= 100) throw new Error(`relay did not start:\n${output}`);
    await sleep(100);
  }

  // ③ 계측 필드
  const first = await health();
  assert.equal(typeof first.memory?.heapUsedMB, "number");
  assert.ok("footprintMB" in first.memory, "memory.footprintMB 가 없다");
  assert.equal(typeof first.state?.clientMeta, "number");
  assert.equal(typeof first.state?.sendBuffer?.totalKB, "number");
  for (const key of ["channels", "emptyChannels", "channelDocs", "requests", "bulkJobs", "previewSubscriptions", "eventLog", "monitors"]) {
    assert.equal(typeof first.state[key], "number", `state.${key} 가 없다`);
  }

  // ① 사이드카: 첫 목록이 만들고, 그 뒤로는 인덱스 파일이 아니라 사이드카를 읽는다.
  const status = await (await fetch(`${base}/index/status`)).json();
  assert.deepEqual(status.diskIndexes.map((d) => [d.projectKey, d.nodeCount]), [["Legacy", 3]]);
  assert.ok(existsSync(`${indexFile}.summary`), "인덱스 요약 사이드카가 생기지 않았다");
  // 인덱스 본문을 깨뜨려도 목록은 사이드카로 답해야 한다 — 다시 파싱하지 않는다는 뜻.
  // (사이드카 mtime 이 본문보다 새로워야 하므로 본문은 건드리지 않고 사이드카만 바꿔 확인한다.)
  writeFileSync(`${indexFile}.summary`, JSON.stringify({ projectKey: "Legacy", projectName: "Legacy", builtAt: 1, updatedAt: 2, pageCount: 1, nodeCount: 99, file: "x" }));
  const again = await (await fetch(`${base}/index/status`)).json();
  assert.equal(again.diskIndexes[0].nodeCount, 99, "목록이 사이드카 대신 인덱스 파일을 다시 파싱했다");
  assert.equal(again.diskIndexes[0].file, "project-Legacy.json");

  // ② 무거운 인덱스 경로 뒤의 힙 반환
  await sleep(600);
  const released = await health();
  assert.ok(released.memory.heapRelease.count >= 1, "인덱스 목록 뒤에 힙 반환이 돌지 않았다");

  // ④ 멈춘 콘솔 — 문서 크기가 큰 채널을 만들어 두면 이후 이벤트마다 큰 스냅샷이 쌓인다.
  const plugin = await open();
  sockets.push(plugin);
  plugin.send(JSON.stringify({ type: "hello", role: "figma", protocolVersion: PROTOCOL_VERSION }));
  await waitFor(plugin, (d) => d.event === "hello_ack");
  plugin.send(JSON.stringify({ type: "join", channel: "big" }));
  await waitFor(plugin, (d) => d.message && typeof d.message === "object" && "result" in d.message);
  plugin.send(JSON.stringify({ type: "announce", channel: "big", document: { documentName: "Big", pad: "x".repeat(64 * 1024) } }));
  const monitor = await stalledMonitor();
  sockets.push({ close: () => monitor.destroy() });
  await sleep(300);
  assert.equal((await health()).connections.monitor, 1);
  let dropped = false;
  for (let round = 0; round < 60 && !dropped; round++) {
    const controller = await open();
    controller.send(JSON.stringify({ type: "hello", role: "controller", protocolVersion: PROTOCOL_VERSION, requesterId: randomUUID() }));
    await waitFor(controller, (d) => d.event === "hello_ack");
    controller.close();
    if (round % 10 === 9) {
      await sleep(400); // 하트비트 스윕(300ms)이 한 번은 돈다
      dropped = (await health()).connections.monitor === 0;
    }
  }
  assert.ok(dropped, "읽기를 멈춘 콘솔이 송신 버퍼를 쥔 채 남았다");

  process.stdout.write("relay memory (index sidecar, heap release, diagnostics, stalled console) passed\n");
} catch (error) {
  process.stderr.write(output.slice(-4000));
  throw error;
} finally {
  for (const socket of sockets) { try { socket.close(); } catch {} }
  relay.kill("SIGTERM");
  rmSync(home, { recursive: true, force: true });
}
