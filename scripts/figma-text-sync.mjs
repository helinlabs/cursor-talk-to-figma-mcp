#!/usr/bin/env node
/**
 * 템플릿 행 ↔ 번역 행 사이의 텍스트를 옮긴다.
 *
 * 같은 트리에서 복제한 프레임들은 **텍스트 노드 순서가 1:1로 대응**한다. 그 성질만 쓰면
 * 번역맵을 만들거나(pull) 적용하는(apply) 게 이름 매칭 없이 정확히 된다.
 *
 *   pull   템플릿(영문) ↔ 각 언어 행을 대조해 "원문 → 번역" 맵을 뽑는다
 *   apply  맵을 대상 행에 부어 넣는다
 *
 * ⚠️ 요일처럼 **위치가 곧 의미**인 것은 이 방식으로 다루면 안 된다. 영문 M/T/W/T/F/S/S 는
 *    T·S 가 중복이라 문자열 맵으로 만들면 화·목이 뭉개진다. 그런 건 x 좌표 순서로 따로 넣는다.
 *
 * 사용:
 *   node figma-text-sync.mjs pull  <channel> <spec.json> <out.json>
 *   node figma-text-sync.mjs apply <channel> <spec.json> <map.json> [--locale it]
 *
 * spec.json = { "template": {"1":"<nodeId>", ...}, "rows": { "it": {"1":"<nodeId>", ...}, ... } }
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BATCH = path.join(HERE, "figma-batch-client.mjs");

function runBatch(channel, cmds) {
  const dir = mkdtempSync(path.join(tmpdir(), "figsync-"));
  const inFile = path.join(dir, "cmds.json");
  const outFile = path.join(dir, "out.json");
  writeFileSync(inFile, JSON.stringify(cmds));
  execFileSync("node", [BATCH, channel, inFile, outFile, "--fresh"], { stdio: "inherit" });
  return JSON.parse(readFileSync(outFile, "utf8"));
}

const scanCmds = (spec) => {
  const out = [];
  for (const [k, id] of Object.entries(spec.template)) out.push({ label: `T|${k}`, command: "scan_text_nodes", params: { nodeId: id, chunkSize: 80 } });
  for (const [loc, frames] of Object.entries(spec.rows))
    for (const [k, id] of Object.entries(frames)) out.push({ label: `${loc}|${k}`, command: "scan_text_nodes", params: { nodeId: id, chunkSize: 80 } });
  return out;
};

const index = (res) => {
  const by = {};
  for (const r of res) {
    const [loc, frame] = r.label.split("|");
    (by[loc] ||= {})[frame] = (r.result?.textNodes || []).map((n) => [n.id, n.characters]);
  }
  return by;
};

function pull(channel, spec, outPath) {
  const by = index(runBatch(channel, scanCmds(spec)));
  const T = by.T || {};
  const copy = {};
  const skew = [];
  for (const loc of Object.keys(spec.rows)) {
    const m = {};
    for (const [frame, tnodes] of Object.entries(T)) {
      const ln = by[loc]?.[frame] || [];
      // 구조가 어긋나면 조용히 잘못 매핑되므로 그 프레임은 통째로 건너뛴다.
      if (ln.length !== tnodes.length) { skew.push(`${loc}_${frame} (${tnodes.length}≠${ln.length})`); continue; }
      tnodes.forEach(([, en], i) => { const tr = ln[i][1]; if (en !== tr) m[en] = tr; });
    }
    copy[loc] = m;
  }
  writeFileSync(outPath, JSON.stringify({ copy }, null, 1));
  console.log(`추출: ${Object.entries(copy).map(([l, m]) => `${l} ${Object.keys(m).length}`).join(", ")}`);
  if (skew.length) console.log(`⚠️ 구조 불일치로 건너뜀: ${skew.join(", ")}`);
}

function apply(channel, spec, mapPath, only) {
  const { copy } = JSON.parse(readFileSync(mapPath, "utf8"));
  const locales = only ? [only] : Object.keys(spec.rows);
  const by = index(runBatch(channel, scanCmds({ template: {}, rows: Object.fromEntries(locales.map((l) => [l, spec.rows[l]])) })));
  const cmds = [];
  for (const loc of locales) {
    const m = copy[loc] || {};
    for (const [frame, nodes] of Object.entries(by[loc] || {})) {
      const text = nodes.filter(([, c]) => m[c] !== undefined).map(([id, c]) => ({ nodeId: id, text: m[c] }));
      if (text.length) cmds.push({ label: `${loc}_${frame} (${text.length})`, command: "set_multiple_text_contents", params: { nodeId: spec.rows[loc][frame], text } });
    }
  }
  if (!cmds.length) return console.log("적용할 것이 없다");
  runBatch(channel, cmds);
  console.log(`적용 ${cmds.length}개 프레임`);
}

const [, , mode, channel, specPath, arg4] = process.argv;
if (!mode || !channel || !specPath) {
  console.error("usage: figma-text-sync.mjs pull|apply <channel> <spec.json> <out|map.json> [--locale x]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const li = process.argv.indexOf("--locale");
if (mode === "pull") pull(channel, spec, arg4);
else if (mode === "apply") apply(channel, spec, arg4, li > -1 ? process.argv[li + 1] : null);
else { console.error(`알 수 없는 모드: ${mode}`); process.exit(2); }
