// ---------------------------------------------------------------------------
// Project context documents — a per-project markdown file describing what the
// FILE STRUCTURE MEANS: page purposes (e.g. "레퍼런스 페이지 = 타사 캡처 모음,
// 우리 디자인 아님"), naming conventions, where features live, and common
// misidentification traps. The Figma-side analogue of a code repo's CLAUDE.md.
//
// SOURCE OF TRUTH IS THE FIGMA DOCUMENT ITSELF, not this module: the document
// stores JSON {content, updatedAt, updatedBy?} in
// figma.root.setSharedPluginData("talk_to_figma", "project_context"), so the
// context travels with the file through Figma cloud sync and survives being
// opened on another machine/relay. The plugin commands
// get_project_context / set_project_context are the only writers.
//
// This module is only the LOCAL READ CACHE shared by the MCP server and the
// relay console: every successful live read mirrors the document value to
// ~/.talk-to-figma/context/<sanitizedKey>.json so the console can show the
// last-known copy (marked stale) when no plugin is online, and so search_nodes
// can cheaply flag "this project has a context document" without a plugin
// round-trip. Writes are atomic (tmp→rename) because two processes share the
// files. Never treat the cache as authoritative.
// ---------------------------------------------------------------------------
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const CONTEXT_DIR = path.join(os.homedir(), ".talk-to-figma", "context");

// Same sanitization rule as the search index files.
function sanitizeKey(projectKey: string): string {
  return projectKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function projectContextCachePath(projectKey: string): string {
  return path.join(CONTEXT_DIR, `${sanitizeKey(projectKey)}.json`);
}

export type CachedProjectContext = {
  content: string;
  updatedAt: string | null; // ISO timestamp from the document record
  updatedBy?: string | null;
  cachedAt: string; // when this mirror copy was written
};

// Load the last mirrored copy for a project. Returns null when none exists
// (missing/corrupt cache just means "no cached copy").
export function loadCachedProjectContext(projectKey: string): CachedProjectContext | null {
  try {
    const raw = JSON.parse(fs.readFileSync(projectContextCachePath(projectKey), "utf8"));
    if (raw && typeof raw.content === "string") {
      return {
        content: raw.content,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
        updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : null,
        cachedAt: typeof raw.cachedAt === "string" ? raw.cachedAt : "",
      };
    }
  } catch {
    // fall through
  }
  return null;
}

// Mirror a live document read (or a just-completed write) into the cache.
// Best-effort: cache failures must never fail the live operation.
export function cacheProjectContext(
  projectKey: string,
  record: { content: string; updatedAt?: string | null; updatedBy?: string | null }
): void {
  try {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    const file = projectContextCachePath(projectKey);
    const tmp = path.join(
      CONTEXT_DIR,
      `.${sanitizeKey(projectKey)}.${process.pid}.${Date.now()}.tmp`
    );
    const payload: CachedProjectContext = {
      content: record.content,
      updatedAt: record.updatedAt ?? null,
      ...(record.updatedBy ? { updatedBy: record.updatedBy } : {}),
      cachedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // best-effort mirror only
  }
}

// Drop the mirror (used when the document's context was cleared).
export function clearCachedProjectContext(projectKey: string): void {
  try {
    fs.rmSync(projectContextCachePath(projectKey), { force: true });
  } catch {
    // best-effort
  }
}

// True when the cache holds a non-empty context for the project. Cheap enough
// to call on every search. NOTE: cache-based — a project whose context was
// never read on this machine reports false until the first live read (which
// use_figma_project performs automatically).
export function hasCachedProjectContext(projectKey: string): boolean {
  const cached = loadCachedProjectContext(projectKey);
  return !!cached && cached.content.trim().length > 0;
}
