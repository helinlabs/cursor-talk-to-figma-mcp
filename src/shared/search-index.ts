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
// normalized matching used against it — do not reimplement elsewhere.
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

// Find where a query matches inside `haystack`, case-insensitively, either as
// a plain substring or with ALL whitespace stripped from both sides — so
// "gym chat" matches a "GymChat" layer and vice versa. Returns a
// {start, end} range in the ORIGINAL string, or null.
export function findNormalizedMatch(
  haystack: string,
  qLower: string,
  qLowerNoSpace: string
): { start: number; end: number } | null {
  const lower = haystack.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx !== -1) return { start: idx, end: idx + qLower.length };
  if (!qLowerNoSpace) return null;
  const map: number[] = [];
  let stripped = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (!/\s/.test(ch)) {
      stripped += ch;
      map.push(i);
    }
  }
  const sIdx = stripped.indexOf(qLowerNoSpace);
  if (sIdx === -1) return null;
  return { start: map[sIdx], end: map[sIdx + qLowerNoSpace.length - 1] + 1 };
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

export type QueryNeedle = { raw: string; qLower: string; qLowerNoSpace: string };

export function buildNeedles(queries: string[]): QueryNeedle[] {
  const needles: QueryNeedle[] = [];
  const seen = new Set<string>();
  for (const raw of queries) {
    const qLower = raw.toLowerCase();
    const qLowerNoSpace = qLower.replace(/\s+/g, "");
    if (!qLowerNoSpace || seen.has(qLowerNoSpace)) continue;
    seen.add(qLowerNoSpace);
    needles.push({ raw, qLower, qLowerNoSpace });
  }
  return needles;
}
