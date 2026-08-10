#!/usr/bin/env node
// 릴레이에 여러 명령을 순차로 보내는 배치 클라이언트.
//
//   node figma-batch-client.mjs <channel> <commands.json> [out.json] [--fresh]
//
// commands.json 은 [{label?, command, params}] 배열. 결과는 out.json 에 쓰고
// stdout 에는 한 줄 요약만 찍는다 — 스캔 결과가 수만 자라 그대로 보면 컨텍스트가 날아간다.
//
// **재개** — 배치가 100건을 넘으면 셸 타임아웃이나 릴레이 끊김으로 중간에 죽는 일이 흔하다.
// 그래서 결과를 명령마다 out.json 에 흘려 쓰고, 다시 실행하면 이미 끝난 앞부분을 건너뛴다.
// 건너뛸지는 인덱스가 아니라 **명령 내용의 해시**로 판단한다 — commands.json 을 고쳤으면
// 바뀐 지점부터 다시 돌아야지, 인덱스만 믿으면 엉뚱한 결과를 완료로 오인한다.
// `--fresh` 를 주면 기존 결과를 무시하고 처음부터 돌린다.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const argv = process.argv.slice(2);
const fresh = argv.includes("--fresh");
const [channel, cmdFile, outFile] = argv.filter((a) => !a.startsWith("--"));
if (!channel || !cmdFile) {
  console.error("usage: figma-batch-client.mjs <channel> <commands.json> [out.json] [--fresh]");
  process.exit(2);
}

const commands = JSON.parse(readFileSync(cmdFile, "utf8"));
const keyOf = (c) => createHash("sha1").update(JSON.stringify([c.command, c.params ?? {}])).digest("hex").slice(0, 16);

// 앞서 끝난 결과를 이어받는다. 해시가 어긋나는 첫 지점에서 멈추고 거기서부터 다시 보낸다.
let results = [];
if (outFile && existsSync(outFile) && !fresh) {
  try {
    const prev = JSON.parse(readFileSync(outFile, "utf8"));
    for (let i = 0; i < prev.length && i < commands.length; i += 1) {
      if (prev[i]?.key !== keyOf(commands[i]) || prev[i]?.error) break;
      results.push(prev[i]);
    }
  } catch { results = []; }
}
let idx = results.length;
if (idx > 0) console.log(`resume: ${idx}/${commands.length} 건 건너뜀`);

const rid = () => Math.random().toString(36).slice(2);
const ws = new WebSocket("ws://localhost:3055");
let joined = false;
let pending = null;
let timer = null;

const flush = () => { if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2)); };

// 명령마다 타이머를 새로 건다. 스캔은 오래 걸리고 progress_update 가 살아있음을 알려 준다.
function arm() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.error(`TIMEOUT on #${idx} ${commands[idx]?.command} — 다시 실행하면 여기서 이어집니다`);
    finish(1);
  }, 120000);
}

function send() {
  if (idx >= commands.length) return finish(0);
  const { command, params = {} } = commands[idx];
  pending = rid();
  arm();
  ws.send(JSON.stringify({
    id: pending,
    type: "message",
    channel,
    message: { id: pending, command, params: { ...params, commandId: pending } },
  }));
}

function finish(code) {
  clearTimeout(timer);
  flush();
  const bad = results.filter((r) => r.error).length;
  console.log(`done ${results.length}/${commands.length} commands, ${bad} error(s)`);
  for (const r of results) if (r.error) console.log(`  ✗ ${r.label}: ${JSON.stringify(r.error).slice(0, 300)}`);
  process.exit(code);
}

ws.on("open", () => {
  const id = rid();
  ws.send(JSON.stringify({ id, type: "join", channel, message: { id, command: "join", params: { channel } } }));
});

ws.on("message", (raw) => {
  let data;
  try { data = JSON.parse(raw.toString()); } catch { return; }

  if (!joined && data.type === "system") { joined = true; return send(); }
  if (data.type === "progress_update") return arm(); // 살아 있다 — 타이머만 연장

  const msg = data.message;
  if (!msg || msg.id !== pending) return;
  const c = commands[idx];
  results.push({ key: keyOf(c), label: c.label ?? c.command, error: msg.error, result: msg.result });
  idx += 1;
  flush();   // 명령마다 흘려 쓴다 — 중간에 죽어도 여기까지는 남는다
  send();
});

ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });

// 셸 타임아웃은 SIGTERM 으로 온다. 지금까지 결과를 남기고 나가야 재개가 성립한다.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { console.error(`${sig} — ${results.length}건까지 저장하고 종료`); finish(1); });
}
