// 릴레이 메모리 재현 — macmini-1 (2026-10-16) 의 릴레이가 연결 ~115개에 2GB 까지 자란
// 원인을 찾으려고 만든 부하 스크립트. 테스트가 아니라 측정 도구다.
//
// 임시 HOME·별도 포트로 릴레이를 띄우고, 가짜 Figma 플러그인 N개(hello → join → announce,
// 명령마다 결과 응답)와 figma-mcp 세션처럼 행동하는 controller(hello → join → heartbeat
// → 명령 몇 개 → close)를 계속 열고 닫는다. 라운드마다 /health 의 memory·state 를 찍는다.
//
//   node scripts/relay-churn-repro.mjs [--rounds=20] [--churn=200] [--persistent=106]
//                                      [--plugins=8] [--monitor=none|reading|stalled]
//                                      [--payloadKB=0]
//
// --monitor=stalled 는 콘솔 탭이 백그라운드로 멈춘 것처럼 읽지 않는 monitor 를 하나 붙인다.
// --payloadKB 는 플러그인 응답 크기(get_document_info 같은 큰 결과)를 흉내 낸다.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const ROUNDS = Number(arg("rounds", 20));
const CHURN = Number(arg("churn", 200));
const PERSISTENT = Number(arg("persistent", 106));
const PLUGINS = Number(arg("plugins", 8));
const MONITOR = arg("monitor", "none");
const PAYLOAD_KB = Number(arg("payloadKB", 0));
// 정상 상태 모드: 상주 연결의 heartbeat 간격(ms)과 HTTP 폴링(/projects·/health) 간격.
// macmini-1 은 10초 heartbeat — 50ms 로 돌리면 200배 압축이다.
const BEAT_MS = Number(arg("beatMs", 2000));
const POLL_MS = Number(arg("pollMs", 0));
const ROUND_SEC = Number(arg("roundSec", 0));
// 헬스 워처의 export_node_as_image 처럼 바이너리 프레임으로 돌아오는 응답(KB). 0 이면 끔.
// --binaryCaps=0 이면 controller 가 binaryFrames 를 광고하지 않아 릴레이가 base64 로 바꾼다
// (헬스 워처가 그렇다).
const BINARY_KB = Number(arg("binaryKB", 0));
const BINARY_CAPS = arg("binaryCaps", "1") === "1";
const PROTOCOL_VERSION = "2.6.0";

const bun = process.env.BUN || "bun";
if (spawnSync(bun, ["--version"]).status !== 0) throw new Error("bun not found");

const port = 48000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const url = `ws://127.0.0.1:${port}`;
const workDir = mkdtempSync(join(tmpdir(), "relay-churn-"));
const relay = spawn(bun, ["run", join(process.cwd(), "src/socket.ts")], {
  cwd: workDir,
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, HOME: workDir, PORT: String(port) },
});
let stderr = "";
relay.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const payload = PAYLOAD_KB > 0 ? "x".repeat(PAYLOAD_KB * 1024) : null;

async function health() {
  return (await fetch(`${base}/health`)).json();
}

function open() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitFor(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("timeout")); }, timeoutMs);
    function onMessage(raw) {
      let data;
      try { data = JSON.parse(raw.toString()); } catch {
        if (raw.length > 8 && raw.subarray(0, 4).toString() === "TTFB") data = JSON.parse(raw.subarray(8, 8 + raw.readUInt32BE(4)).toString());
        else return;
      }
      if (predicate(data)) { clearTimeout(timer); socket.off("message", onMessage); resolve(data); }
    }
    socket.on("message", onMessage);
  });
}

function binaryFrame(envelope, payload) {
  const header = Buffer.from(JSON.stringify(envelope));
  const prefix = Buffer.alloc(8);
  Buffer.from("TTFB").copy(prefix, 0);
  prefix.writeUInt32BE(header.length, 4);
  return Buffer.concat([prefix, header, payload]);
}

async function plugin(index) {
  const socket = await open();
  const channel = `chan-${index}`;
  socket.send(JSON.stringify({ type: "hello", role: "figma", protocolVersion: PROTOCOL_VERSION, requesterId: `plugin-${index}` }));
  await waitFor(socket, (data) => data.event === "hello_ack");
  socket.send(JSON.stringify({ type: "join", channel }));
  await waitFor(socket, (data) => typeof data.message === "object" && data.message && "result" in data.message);
  socket.send(JSON.stringify({ type: "announce", channel, document: { documentName: `Doc ${index}`, fileKey: `file${index}`, page: "Page 1" } }));
  socket.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type !== "broadcast" || !data.message?.command) return;
    if (data.message.command === "export_node_as_image") {
      const envelope = { type: "message", channel, message: { id: data.message.id, result: { binary: true, mimeType: "image/png" } } };
      socket.send(binaryFrame(envelope, randomBytes(BINARY_KB * 1024)));
      return;
    }
    const result = data.message.command === "run_script"
      ? { result: JSON.stringify(`Doc ${index}`) }
      : { ok: true, ...(payload ? { blob: payload } : {}) };
    socket.send(JSON.stringify({ type: "message", channel, message: { id: data.message.id, result } }));
  });
  const beat = setInterval(() => socket.send(JSON.stringify({ type: "heartbeat", role: "figma" })), 5000);
  return { socket, channel, stop: () => { clearInterval(beat); socket.close(); } };
}

async function controller(channel, commands) {
  const socket = await open();
  socket.send(JSON.stringify({ type: "hello", role: "controller", requesterId: "mcp-1", protocolVersion: PROTOCOL_VERSION, deviceName: "repro", capabilities: BINARY_CAPS ? ["binaryFrames"] : [] }));
  await waitFor(socket, (data) => data.event === "hello_ack");
  const joinId = randomUUID();
  socket.send(JSON.stringify({ id: joinId, type: "join", channel, message: { id: joinId, command: "join", params: { channel } } }));
  await waitFor(socket, (data) => data.message?.id === joinId);
  for (let i = 0; i < commands; i++) {
    const id = randomUUID();
    const command = BINARY_KB > 0 && i % 2 === 1 ? "export_node_as_image" : "get_document_info";
    socket.send(JSON.stringify({ id, type: "message", channel, message: { id, command, params: {} } }));
    await waitFor(socket, (data) => data.message?.id === id, 15000);
  }
  socket.send(JSON.stringify({ type: "heartbeat", role: "controller", requesterId: "mcp-1", channel }));
  return socket;
}

// 업그레이드만 하고 아무것도 읽지 않는 monitor — 백그라운드에서 멈춘 콘솔 탭.
function stalledMonitor() {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([
        "GET / HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`, "Sec-WebSocket-Version: 13", "", "",
      ].join("\r\n"));
    });
    socket.once("data", () => {
      // 마스킹된 텍스트 프레임 하나: {"type":"monitor"} — 그 뒤로는 읽기를 멈춘다.
      const body = Buffer.from(JSON.stringify({ type: "monitor" }));
      const mask = randomBytes(4);
      const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]));
      socket.pause();
      resolve(socket);
    });
  });
}

function summarize(label, h) {
  const m = h.memory || {};
  const s = h.state || {};
  return `${label.padEnd(10)} fp=${m.footprintMB}MB rss=${m.rssMB}MB heap=${m.heapUsedMB}MB jscObjs=${m.jsc?.objectCount} ` +
    `conns=${h.connections?.total} chan=${s.channels} members=${s.channelMembers} req=${s.requests} ` +
    `eventLog=${s.eventLog} sendBuf=${s.sendBuffer?.totalKB}KB(max ${s.sendBuffer?.maxKB}KB, ${s.sendBuffer?.backloggedSockets} socks)`;
}

try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (attempt > 100) throw new Error(`relay did not start:\n${stderr}`);
    await sleep(100);
  }
  const plugins = [];
  for (let i = 0; i < PLUGINS; i++) plugins.push(await plugin(i));
  let monitor = null;
  if (MONITOR === "stalled") monitor = await stalledMonitor();
  if (MONITOR === "reading") { monitor = await open(); monitor.send(JSON.stringify({ type: "monitor" })); }
  const persistent = [];
  for (let i = 0; i < PERSISTENT; i++) persistent.push(await controller(plugins[i % PLUGINS].channel, 0));
  const beat = setInterval(() => {
    for (const socket of persistent) if (socket.readyState === 1) socket.send(JSON.stringify({ type: "heartbeat", role: "controller", requesterId: "mcp-1" }));
  }, BEAT_MS);
  const poll = POLL_MS > 0 ? setInterval(() => {
    fetch(`${base}/projects`).then((r) => r.text()).catch(() => {});
    fetch(`${base}/channels`).then((r) => r.text()).catch(() => {});
  }, POLL_MS) : null;
  await sleep(500);
  console.log(summarize("baseline", await health()));
  for (let round = 1; round <= ROUNDS; round++) {
    // figma-mcp 의 세션 생성·퇴출: 열고, join 하고, 명령 몇 개, 닫는다. 동시 20개씩.
    for (let done = 0; done < CHURN; done += 20) {
      const batch = await Promise.all(Array.from({ length: Math.min(20, CHURN - done) }, (_, i) =>
        controller(plugins[(done + i) % PLUGINS].channel, 3)));
      for (const socket of batch) socket.close();
    }
    if (ROUND_SEC > 0) await sleep(ROUND_SEC * 1000);
    await sleep(300);
    console.log(summarize(`round ${round}`, await health()));
  }
  clearInterval(beat);
  if (poll) clearInterval(poll);
  for (const socket of persistent) socket.close();
  await sleep(1000);
  console.log(summarize("closed", await health()));
  if (monitor) monitor.destroy?.() ?? monitor.close();
  for (const p of plugins) p.stop();
} catch (error) {
  process.stderr.write(stderr.slice(-4000));
  throw error;
} finally {
  relay.kill("SIGTERM");
  rmSync(workDir, { recursive: true, force: true });
}
