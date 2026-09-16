// Locks the three-stage search_nodes matcher, and locks the MCP server's copy
// of it to the Figma plugin's copy.
//
// Why this exists: on 2026-09-16 a search of GW_Product for the A/B test on
// per-set memos used queries ["세트 메모", "메모"]. The section is named
// "[AB] 세트마다 메모 남기기 기능 추가" and "세트 메모" did not match it at all
// — the matcher only knew a plain substring and a whitespace-stripped
// substring, and "세트메모" never occurs as a run of characters inside
// "세트마다메모남기기". The single-word fallback "메모" matched hundreds of
// unrelated nodes, so the right section was not visible in the results either;
// the section was only found by listing everything named "[AB]".
//
// The fix is a third, looser stage: all words of a multi-word query present
// anywhere, in any order. Because that stage is loose it must never displace an
// exact hit, hence the rank policy asserted below.
//
// The matcher exists twice — src/shared/search-index.ts for the MCP server and
// the relay, src/cursor_mcp_plugin/code.js for the Figma plugin sandbox, which
// cannot import anything. The shared parts are fenced with sentinels in both
// files; this test extracts both copies, fails if they differ by a single byte,
// and then runs the behaviour spec against the extracted source. So the thing
// asserted here is the source both processes actually run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SHARED = fileURLToPath(new URL("../src/shared/search-index.ts", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../src/cursor_mcp_plugin/code.js", import.meta.url));
const sharedSrc = readFileSync(SHARED, "utf8");
const pluginSrc = readFileSync(PLUGIN, "utf8");

function block(source, file, name) {
  const begin = source.indexOf(`>>> ${name}`);
  const end = source.indexOf(`<<< ${name}`);
  assert.ok(begin !== -1 && end !== -1 && end > begin, `${file} must contain a ">>> ${name}" ... "<<< ${name}" block`);
  // Start after the sentinel's own line, stop before the line carrying the
  // closing sentinel, so the comment markers themselves are not evaluated.
  const from = source.indexOf("\n", begin) + 1;
  const to = source.lastIndexOf("\n", source.lastIndexOf("//", end));
  return source.slice(from, to);
}

const NAMES = ["token-match-policy", "match-rank-policy", "normalized-match-body", "build-needles-body"];
const parts = {};
for (const name of NAMES) {
  const fromShared = block(sharedSrc, "src/shared/search-index.ts", name);
  const fromPlugin = block(pluginSrc, "src/cursor_mcp_plugin/code.js", name);
  assert.equal(
    fromPlugin,
    fromShared,
    `"${name}" has drifted between src/shared/search-index.ts and src/cursor_mcp_plugin/code.js — ` +
      `the two matchers must stay byte-identical, so copy one over the other`,
  );
  parts[name] = fromShared;
}

const helpers = `${parts["token-match-policy"]}\n${parts["match-rank-policy"]}\n`;
const findNormalizedMatch = new Function(
  "haystack",
  "qLower",
  "qLowerNoSpace",
  "qTokens",
  helpers + parts["normalized-match-body"],
);
const buildNeedles = new Function("queries", helpers + parts["build-needles-body"]);
const { matchRank, MATCH_RANKS, TOKEN_SPAN_CAP } = new Function(
  `${helpers}\nreturn { matchRank, MATCH_RANKS, TOKEN_SPAN_CAP };`,
)();

// Match a whole query the way every caller does: build the needle, then run it.
const search = (haystack, query) => {
  const needle = buildNeedles([query])[0];
  assert.ok(needle, `buildNeedles dropped the query "${query}"`);
  return findNormalizedMatch(haystack, needle.qLower, needle.qLowerNoSpace, needle.qTokens);
};

// ---------------------------------------------------------------------------
// The 2026-09-16 regression itself.
// ---------------------------------------------------------------------------
const SECTION = "[AB] 세트마다 메모 남기기 기능 추가";

const memo = search(SECTION, "세트 메모");
assert.ok(memo, `"세트 메모" must find "${SECTION}" — this is the case the third stage exists for`);
assert.equal(memo.strength, "tokens", "a match found only by its separated words must be reported as loose");
// The reported range covers the real match: it starts at 세트 and ends after 메모.
assert.equal(SECTION.slice(memo.start, memo.end), "세트마다 메모");

// Word order must not matter — the caller does not know how the designer wrote it.
assert.equal(search(SECTION, "메모 세트")?.strength, "tokens");
// Nor whitespace inside the query beyond splitting it.
assert.equal(search(SECTION, "  세트   메모  ")?.strength, "tokens");

// A word that is simply not there still means no match. The loose stage widens
// which arrangements match, not which words have to be present.
assert.equal(search(SECTION, "세트 알림"), null);
assert.equal(search(SECTION, "세트 메모 타이머"), null);

// ---------------------------------------------------------------------------
// The first two stages are untouched.
// ---------------------------------------------------------------------------
// Stage 1: plain substring.
const plain = search(SECTION, "세트마다 메모");
assert.equal(plain.strength, "exact");
assert.equal(SECTION.slice(plain.start, plain.end), "세트마다 메모");

// Stage 2: whitespace stripped from both sides, the "gym chat" ↔ "GymChat" case.
const gym = search("GymChat Entry", "gym chat");
assert.equal(gym.strength, "exact");
assert.equal("GymChat Entry".slice(gym.start, gym.end), "GymChat");
assert.equal(search("Gym Chat Entry", "gymchat").strength, "exact");

// Case-insensitive, as before.
assert.equal(search("GYMCHAT", "gymchat").strength, "exact");

// ---------------------------------------------------------------------------
// Single-word queries behave exactly as they did — no loose matching at all.
// This is the over-matching guard: one word against a scattered haystack would
// match essentially everything.
// ---------------------------------------------------------------------------
assert.equal(search(SECTION, "메모").strength, "exact");
assert.equal(search(SECTION, "메모").start, SECTION.indexOf("메모"));
assert.equal(search(SECTION, "타이머"), null);
for (const query of ["메모", "gymchat", "[AB]", "세트마다"]) {
  const hit = search(SECTION, query);
  assert.notEqual(hit?.strength, "tokens", `single-word query "${query}" must never produce a loose match`);
}
// A query that is only whitespace has no tokens and no needle at all.
assert.equal(buildNeedles(["   "]).length, 0);

// Omitting qTokens (a caller that has not been updated) disables stage 3, so
// the function is still safe to call with three arguments.
assert.equal(findNormalizedMatch(SECTION, "세트 메모", "세트메모"), null);

// ---------------------------------------------------------------------------
// Needles.
// ---------------------------------------------------------------------------
const needles = buildNeedles(["세트 메모", "Gym Chat", "gymchat", ""]);
// "Gym Chat" and "gymchat" collapse to one needle (same whitespace-stripped
// form), the empty query is dropped.
assert.deepEqual(needles.map((n) => n.raw), ["세트 메모", "Gym Chat"]);
assert.deepEqual(needles[0].qTokens, ["세트", "메모"]);
assert.deepEqual(needles[1].qTokens, ["gym", "chat"]);
assert.equal(needles[1].qLowerNoSpace, "gymchat");

// ---------------------------------------------------------------------------
// Ranking: loose matches always sort after exact ones, so `limit` drops them
// first and an exact hit is never lost to a loose one.
// ---------------------------------------------------------------------------
assert.deepEqual(MATCH_RANKS, ["name:exact", "text:exact", "name:tokens", "text:tokens"]);
assert.ok(matchRank("name", "exact") < matchRank("text", "exact"));
assert.ok(matchRank("text", "exact") < matchRank("name", "tokens"));
assert.ok(matchRank("name", "tokens") < matchRank("text", "tokens"));
// An unflagged match (the shape exact hits keep) ranks as exact.
assert.equal(matchRank("name", undefined), matchRank("name", "exact"));
// Anything unrecognised sorts last rather than landing in the exact buckets.
assert.equal(matchRank("annotation", "whatever"), MATCH_RANKS.length - 1);

// ---------------------------------------------------------------------------
// Snippet range on long TEXT content stays bounded: words scattered across a
// paragraph would otherwise report a range spanning the whole thing, and
// textMatchSnippet pads 40 chars on each side of whatever it is given.
// ---------------------------------------------------------------------------
const long = `세트 ${"가".repeat(400)} 메모`;
const scattered = search(long, "세트 메모");
assert.equal(scattered.strength, "tokens");
assert.ok(
  scattered.end - scattered.start <= TOKEN_SPAN_CAP,
  `a scattered match must report at most TOKEN_SPAN_CAP (${TOKEN_SPAN_CAP}) chars, got ${scattered.end - scattered.start}`,
);
assert.equal(long.slice(scattered.start, scattered.end), "세트");
// Just inside the cap, the range still spans both words.
const near = `세트${"가".repeat(TOKEN_SPAN_CAP - 4)}메모`;
const nearHit = search(near, "세트 메모");
assert.equal(nearHit.end - nearHit.start, TOKEN_SPAN_CAP);
assert.equal(near.slice(nearHit.end - 2, nearHit.end), "메모");

// ---------------------------------------------------------------------------
// Every call site must pass the tokens through, or the whole stage is dead
// code in that path. These are the four places that run the matcher.
// ---------------------------------------------------------------------------
const callers = [
  ["src/talk_to_figma_mcp/server.ts", 2],
  ["src/socket.ts", 1],
  ["src/cursor_mcp_plugin/code.js", 2],
];
for (const [file, expected] of callers) {
  const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
  // Calls only — the plugin file also declares the function.
  const calls = (source.match(/(?<!function )findNormalizedMatch\(/g) || []).length;
  const withTokens = (source.match(/needle\.qTokens/g) || []).length;
  assert.equal(calls, expected, `${file} should call findNormalizedMatch ${expected}x`);
  assert.equal(
    withTokens,
    expected,
    `${file} must pass needle.qTokens to every findNormalizedMatch call — a call that omits it silently loses the token stage`,
  );
}

// ---------------------------------------------------------------------------
// End to end through the plugin's real search_nodes, against a stub Figma
// document. The matcher above is only half the fix: a loose hit that sorted
// ahead of an exact one would still hide the answer as soon as `limit` bites,
// which is how the 2026-09-16 search failed in the first place ("메모" returned
// a wall of unrelated nodes). code.js is a plugin script, not a module, so it
// is loaded into a vm context with the handful of Figma globals it touches at
// startup and searchNodes is called directly.
// ---------------------------------------------------------------------------
const page = {
  id: "1:0",
  name: "Product",
  type: "PAGE",
  parent: null,
  loadAsync: async () => {},
  on: () => {},
  findAll: (visit) => { for (const node of page.nodes) visit(node); },
  nodes: [],
};
const node = (id, name, characters = null) => ({
  id,
  name,
  type: characters === null ? "SECTION" : "TEXT",
  characters,
  parent: page,
});
// Deliberately ordered so that document order alone cannot produce the answer:
// the loose hits come first on the page.
page.nodes = [
  node("1:1", "[AB] 세트마다 메모 남기기 기능 추가"),            // loose name
  node("1:2", "세트 메모 프리셋"),                               // exact name
  node("1:3", "Copy B", "세트마다 자유롭게 메모를 남길 수 있어요"), // loose text
  node("1:4", "Copy A", "세트 메모를 남겨보세요"),                // exact text
];

const figma = {
  showUI: () => {},
  ui: { onmessage: null, postMessage: () => {}, resize: () => {} },
  on: () => {},
  currentPage: page,
  root: { id: "0:0", name: "Doc", children: [page] },
  skipInvisibleInstanceChildren: false,
  getNodeByIdAsync: async (id) => (id === page.id ? page : null),
  clientStorage: { getAsync: async () => null, setAsync: async () => {} },
  fileKey: "FIXTURE",
  editorType: "figma",
  command: null,
  notify: () => {},
};
const context = vm.createContext({
  figma,
  __html__: "<html></html>",
  console: { log: () => {}, warn: () => {}, error: () => {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  WebSocket: function () {},
});
vm.runInContext(pluginSrc, context, { filename: "src/cursor_mcp_plugin/code.js" });
assert.equal(typeof context.searchNodes, "function", "code.js must expose searchNodes in the plugin global scope");

const all = await context.searchNodes({ queries: ["세트 메모"], pageId: page.id });
assert.equal(all.totalMatches, 4);
assert.equal(all.truncated, false);
// Exact name, exact text, loose name, loose text — NOT document order, which
// would have put the two loose hits first.
// (joined into strings because arrays crossing the vm realm boundary are not
// deepStrictEqual to arrays built out here)
assert.equal(all.matches.map((m) => m.id).join(" "), "1:2 1:4 1:1 1:3");
assert.equal(
  all.matches.map((m) => `${m.matchedBy}:${m.matchStrength || "exact"}`).join(" "),
  "name:exact text:exact name:tokens text:tokens",
);
// Exact hits keep the exact shape callers parsed before this change.
assert.ok(!("matchStrength" in all.matches[0]), "an exact hit must not carry a matchStrength field");
// Text hits still carry their snippet, loose ones included (textMatchSnippet
// pads 40 chars either side of the range, which covers these short strings
// whole — what matters is that the loose hit gets a snippet at all).
assert.equal(all.matches[1].matchedText, "세트 메모를 남겨보세요");
assert.equal(all.matches[3].matchedText, "세트마다 자유롭게 메모를 남길 수 있어요");

// The point of the ranking: when `limit` cuts, it cuts the loose hits.
const capped = await context.searchNodes({ queries: ["세트 메모"], pageId: page.id, limit: 2 });
assert.equal(capped.truncated, true);
assert.equal(capped.totalMatches, 4, "totalMatches must still count everything that matched");
assert.equal(capped.matches.map((m) => m.id).join(" "), "1:2 1:4");

// match: "name" still ignores TEXT content, loose stage included.
const namesOnly = await context.searchNodes({ queries: ["세트 메모"], pageId: page.id, match: "name" });
assert.equal(namesOnly.matches.map((m) => m.id).join(" "), "1:2 1:1");

// And a query whose words are not all present finds nothing at all.
const none = await context.searchNodes({ queries: ["세트 알림"], pageId: page.id });
assert.equal(none.totalMatches, 0);

console.log(`search matcher OK — 3 stages, ${NAMES.length} blocks identical across server and plugin, plugin search_nodes ranks exact first`);
