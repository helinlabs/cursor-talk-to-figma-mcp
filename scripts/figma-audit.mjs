#!/usr/bin/env node
/**
 * 눈으로는 안 잡히는 것을 트리에서 찾아낸다.
 *
 *   leftovers  대상 언어가 안 쓰는 문자(한자·한글 등)가 남아 있는 텍스트 노드
 *   hrows      가로로 나란한 컨테이너 (RTL 로 뒤집을 후보)
 *
 * **왜 scan_text_nodes 를 안 쓰나** — 그 명령은 `visible === false` 인 가지를 통째로 건너뛴다.
 * 디자인 파일에는 같은 자리에 대안 사본이 겹쳐 쌓여 있는 경우가 흔해서, 스캔으로 번역하면
 * 맨 위 것만 바뀌고 아래 깔린 원문이 남는다. 렌더에 안 나오니 눈으로도 안 잡힌다.
 * 그래서 여기서는 get_node_info 로 트리를 통째로 받아 훑는다.
 *
 * 사용:
 *   node figma-audit.mjs leftovers <channel> <nodes.json> [--pattern '[一-鿿가-힣]']
 *   node figma-audit.mjs hrows     <channel> <nodes.json>
 *
 * nodes.json = { "라벨": "nodeId", ... }
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BATCH = path.join(HERE, "figma-batch-client.mjs");

// 상태바·재생 컨트롤은 RTL 에서도 뒤집지 않는다(iOS 가 그렇게 둔다).
const SKIP_NAMES = new Set(["statusBar", "Status Bar", "Battery", "Wifi", "Cellular Connection", "Time Style"]);

function trees(channel, nodes) {
  const dir = mkdtempSync(path.join(tmpdir(), "figaudit-"));
  const inFile = path.join(dir, "cmds.json");
  const outFile = path.join(dir, "out.json");
  writeFileSync(inFile, JSON.stringify(Object.entries(nodes).map(([label, nodeId]) => ({
    label, command: "get_node_info",
    params: { nodeId, maxDepth: 12, fields: ["children", "name", "characters"] },
  }))));
  execFileSync("node", [BATCH, channel, inFile, outFile, "--fresh"], { stdio: "inherit" });
  return JSON.parse(readFileSync(outFile, "utf8"));
}

function leftovers(channel, nodes, pattern) {
  const re = new RegExp(pattern, "u");
  const hits = new Map();
  for (const r of trees(channel, nodes)) {
    const walk = (n, p) => {
      const here = `${p}/${(n.name || "").slice(0, 18)}`;
      if (n.characters && re.test(n.characters)) {
        const k = n.characters;
        (hits.get(k) || hits.set(k, []).get(k)).push({ label: r.label, id: n.id, path: here });
      }
      for (const c of n.children || []) walk(c, here);
    };
    if (r.result) walk(r.result, "");
  }
  const total = [...hits.values()].reduce((a, v) => a + v.length, 0);
  console.log(`잔존물 ${hits.size}종 / ${total}개 노드\n`);
  for (const [text, v] of [...hits].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${JSON.stringify(text.slice(0, 44))} × ${v.length}  (${[...new Set(v.map((x) => x.label))].slice(0, 4).join(",")})`);
  }
  console.log(`\n삭제하려면 id 목록을 delete_multiple_nodes 로. **한 프레임만 먼저 지우고 렌더를 대조할 것** —`);
  console.log(`"안 보인다" 가 "안 쓴다" 는 아니다. 인스턴스 내부 노드는 삭제가 거부된다.`);
  return hits;
}

function hrows(channel, nodes) {
  for (const r of trees(channel, nodes)) {
    const found = [];
    const walk = (n, ancestorHit) => {
      if (SKIP_NAMES.has(n.name)) return;
      const kids = (n.children || []).filter((c) => c.absoluteBoundingBox);
      let hit = false;
      if (kids.length >= 2 && !n.id.startsWith("I")) {
        const xs = [...kids].sort((a, b) => a.absoluteBoundingBox.x - b.absoluteBoundingBox.x);
        let ok = true;
        for (let i = 0; i + 1 < xs.length; i += 1) {
          const a = xs[i].absoluteBoundingBox; const b = xs[i + 1].absoluteBoundingBox;
          // 가로로 나란한가: x 구간이 안 겹치고 y 가 크게 어긋나지 않는다
          if (a.x + a.width > b.x + 1 || Math.abs(a.y - b.y) > Math.max(a.height, b.height) * 0.6) { ok = false; break; }
        }
        const span = xs.at(-1).absoluteBoundingBox.x + xs.at(-1).absoluteBoundingBox.width - xs[0].absoluteBoundingBox.x;
        if (ok && span > 60) {
          hit = true;
          // 조상이 이미 대상이면 건너뛴다 — 둘 다 뒤집으면 안쪽이 두 번 뒤집혀 상쇄된다.
          if (!ancestorHit) found.push({ id: n.id, name: (n.name || "").slice(0, 22), n: xs.length, span: Math.round(span) });
        }
      }
      for (const c of n.children || []) walk(c, ancestorHit || hit);
    };
    if (r.result) walk(r.result, false);
    console.log(`${r.label}: 최상위 가로 컨테이너 ${found.length}개`);
    for (const f of found) console.log(`   ${f.id}  ${f.name.padEnd(24)} n=${f.n} span=${f.span}`);
  }
  console.log(`\nmirror_horizontal 로 뒤집는다. 넘치는 행은 set_axis_align(primaryAxisAlignItems:MAX) 와`);
  console.log(`컨테이너 폭 축소까지 같이 해야 첫 항목이 화면 안에 남는다.`);
}

const [, , mode, channel, nodesPath] = process.argv;
if (!mode || !channel || !nodesPath) {
  console.error("usage: figma-audit.mjs leftovers|hrows <channel> <nodes.json> [--pattern re]");
  process.exit(2);
}
const nodes = JSON.parse(readFileSync(nodesPath, "utf8"));
const pi = process.argv.indexOf("--pattern");
if (mode === "leftovers") leftovers(channel, nodes, pi > -1 ? process.argv[pi + 1] : "[\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]");
else if (mode === "hrows") hrows(channel, nodes);
else { console.error(`알 수 없는 모드: ${mode}`); process.exit(2); }
