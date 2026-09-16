// ---------------------------------------------------------------------------
// Disk-persisted per-project search index.
//
// The relay's incremental indexer scans every live project page-by-page
// (plugin command `dump_page_index`) and persists the result here; the MCP
// server's search_nodes reads this index FIRST (both processes run on the
// same machine and share the path) and only falls back to the live per-page
// plugin loop when the index is missing or `fresh: true` is requested.
//
// This module is the single definition of the file format and of the
// normalized matching used against it — do not reimplement elsewhere. The one
// unavoidable second copy is the Figma plugin's (it cannot import anything);
// see the sentinel fences under "Matching" below, which hold that copy to
// this one byte for byte.
// Writes are atomic (tmp→rename) because relay and MCP server share files.
// ---------------------------------------------------------------------------
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type IndexedNodeEntry = {
  id: string;
  name: string;
  type: string;
  characters: string | null; // TEXT nodes only
  path: string; // "Page > Section > … > Parent"
};

export type PageIndex = {
  pageId: string;
  pageName: string;
  builtAt: number; // epoch ms, when the plugin walked this page
  nodeCount: number;
  entries: IndexedNodeEntry[];
};

export type ProjectIndex = {
  projectKey: string;
  projectName?: string;
  builtAt: number | null; // epoch ms of the last COMPLETED full build
  updatedAt: number; // epoch ms of the last page merge
  pageCount: number;
  nodeCount: number;
  pages: PageIndex[];
};

export const INDEX_DIR = path.join(os.homedir(), ".talk-to-figma", "index");

function sanitizeKey(projectKey: string): string {
  return projectKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

// Project index files are prefixed so they can never collide with
// annotations.json / progress.json living in the same directory.
export function projectIndexPath(projectKey: string): string {
  return path.join(INDEX_DIR, `project-${sanitizeKey(projectKey)}.json`);
}

export function loadProjectIndex(projectKey: string): ProjectIndex | null {
  try {
    const raw = JSON.parse(fs.readFileSync(projectIndexPath(projectKey), "utf8"));
    if (raw && typeof raw.projectKey === "string" && Array.isArray(raw.pages)) {
      return raw as ProjectIndex;
    }
  } catch (error) {
    // Missing/corrupt index file — caller falls back to a live search.
  }
  return null;
}

export function saveProjectIndex(index: ProjectIndex): void {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  index.pageCount = index.pages.length;
  index.nodeCount = index.pages.reduce((sum, p) => sum + (p.nodeCount || 0), 0);
  index.updatedAt = Date.now();
  const file = projectIndexPath(index.projectKey);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, file);
}

// List every persisted project index WITHOUT loading node entries into the
// result (summary fields only) — for status endpoints.
export function listProjectIndexSummaries(): Array<Omit<ProjectIndex, "pages"> & { file: string }> {
  try {
    return fs
      .readdirSync(INDEX_DIR)
      .filter((f) => f.startsWith("project-") && f.endsWith(".json"))
      .map((f) => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), "utf8"));
          return {
            projectKey: raw.projectKey,
            projectName: raw.projectName,
            builtAt: raw.builtAt ?? null,
            updatedAt: raw.updatedAt ?? null,
            pageCount: raw.pageCount ?? (Array.isArray(raw.pages) ? raw.pages.length : 0),
            nodeCount: raw.nodeCount ?? 0,
            file: f,
          };
        } catch {
          return null;
        }
      })
      .filter((s): s is any => !!s && typeof s.projectKey === "string");
  } catch {
    return [];
  }
}

// --- Matching (must stay behaviorally identical to the plugin's matcher) ----
//
// The Figma plugin sandbox cannot import this module, so
// src/cursor_mcp_plugin/code.js carries a second copy of the matcher. Every
// piece the two copies share is fenced with ">>> name" / "<<< name" sentinels
// and must be BYTE-IDENTICAL in both files: scripts/search-token-match.test.mjs
// extracts both copies, fails if they have drifted, and runs the behaviour spec
// against the extracted source so there is only one definition being tested.

// >>> token-match-policy
// Third and loosest stage of the matcher: every whitespace-separated token of
// the query must appear somewhere in the haystack, order-independent and not
// necessarily adjacent. This is what lets the query "세트 메모" find the section
// named "[AB] 세트마다 메모 남기기 기능 추가" — neither the plain-substring stage
// nor the whitespace-stripped stage can see that name, because "세트메모" never
// occurs as a run of characters inside "세트마다메모남기기".
//
// Single-token queries are excluded on purpose: stage 1 already decides those,
// so this stage could only relabel an exact hit as loose, and a one-token query
// is exactly the case where order-independent matching drags in everything.
const TOKEN_SPAN_CAP = 160;

function splitQueryTokens(qLower) {
  return qLower.split(/\s+/).filter((token) => token.length > 0);
}

function findTokenMatch(lower, qTokens) {
  if (!qTokens || qTokens.length < 2) return null;
  let spanStart = -1;
  let spanEnd = -1;
  let leadEnd = -1;
  for (const token of qTokens) {
    const at = lower.indexOf(token);
    if (at === -1) return null;
    const end = at + token.length;
    if (spanStart === -1 || at < spanStart) {
      spanStart = at;
      leadEnd = end;
    }
    if (end > spanEnd) spanEnd = end;
  }
  // The range spans the first occurrence of every token so a TEXT snippet shows
  // the whole match in context. Tokens scattered far apart would swamp that
  // snippet, so past the cap we report the leftmost token on its own.
  if (spanEnd - spanStart > TOKEN_SPAN_CAP) {
    return { start: spanStart, end: leadEnd, strength: "tokens" };
  }
  return { start: spanStart, end: spanEnd, strength: "tokens" };
}
// <<< token-match-policy

// >>> match-rank-policy
// Result order. Every exact match outranks every loose (token) match, and
// within one strength a name hit outranks a text hit. A `limit` cut therefore
// drops loose matches first: an exact hit is never dropped to make room for a
// loose one, which is the entire reason the two strengths are ranked apart.
const MATCH_RANKS = ["name:exact", "text:exact", "name:tokens", "text:tokens"];

function matchRank(matchedBy, matchStrength) {
  const rank = MATCH_RANKS.indexOf(matchedBy + ":" + (matchStrength || "exact"));
  return rank === -1 ? MATCH_RANKS.length - 1 : rank;
}
// <<< match-rank-policy

export { matchRank, MATCH_RANKS };

// `strength` is "exact" (stages 1-2) or "tokens" (stage 3). It is typed as a
// plain string because the matcher body is shared verbatim with the untyped
// plugin copy, which cannot carry a literal union.
export type NormalizedMatch = { start: number; end: number; strength: string };

// Find where a query matches inside `haystack`, case-insensitively, in three
// stages: (1) as a plain substring, (2) as a substring with ALL whitespace
// stripped from both sides — so "gym chat" matches a "GymChat" layer and vice
// versa — and (3) with every query token present somewhere, in any order and
// possibly far apart (see token-match-policy above). Stages 1 and 2 report
// strength "exact", stage 3 reports "tokens". Returns a {start, end} range in
// the ORIGINAL string, or null. Omitting `qTokens` disables stage 3.
export function findNormalizedMatch(
  haystack: string,
  qLower: string,
  qLowerNoSpace: string,
  qTokens?: string[]
): NormalizedMatch | null {
  // >>> normalized-match-body
  const lower = haystack.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx !== -1) return { start: idx, end: idx + qLower.length, strength: "exact" };
  if (!qLowerNoSpace) return null;
  // Whitespace-stripped comparison, mapping stripped indices back to originals.
  const map = [];
  let stripped = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (!/\s/.test(ch)) {
      stripped += ch;
      map.push(i);
    }
  }
  const sIdx = stripped.indexOf(qLowerNoSpace);
  if (sIdx !== -1) {
    return {
      start: map[sIdx],
      end: map[sIdx + qLowerNoSpace.length - 1] + 1,
      strength: "exact",
    };
  }
  return findTokenMatch(lower, qTokens);
  // <<< normalized-match-body
}

// Snippet of matched TEXT characters: up to 40 chars of context each side.
export function textMatchSnippet(
  characters: string,
  range: { start: number; end: number } | null
): string | null {
  if (!range) return null;
  const start = Math.max(0, range.start - 40);
  const end = Math.min(characters.length, range.end + 40);
  return (
    (start > 0 ? "…" : "") +
    characters.slice(start, end) +
    (end < characters.length ? "…" : "")
  );
}

export type QueryNeedle = {
  raw: string;
  qLower: string;
  qLowerNoSpace: string;
  qTokens: string[];
};

export function buildNeedles(queries: string[]): QueryNeedle[] {
  // >>> build-needles-body
  const needles = [];
  const seen = new Set();
  for (const raw of queries) {
    const qLower = raw.toLowerCase();
    const qLowerNoSpace = qLower.replace(/\s+/g, "");
    if (!qLowerNoSpace || seen.has(qLowerNoSpace)) continue; // skip empty/dupes
    seen.add(qLowerNoSpace);
    needles.push({
      raw: raw,
      qLower: qLower,
      qLowerNoSpace: qLowerNoSpace,
      qTokens: splitQueryTokens(qLower),
    });
  }
  return needles;
  // <<< build-needles-body
}
