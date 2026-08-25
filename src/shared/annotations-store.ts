// ---------------------------------------------------------------------------
// Search annotations — a learned keyword→node index maintained by callers.
//
// When a node could NOT be found via search_nodes but was identified through
// another route (a task, a Slack link, an operator answer), the caller
// registers the keyword→node link; on wrong-answer feedback it removes it.
// search_nodes surfaces matching annotations at the top of its results.
//
// This module is the SINGLE definition of the file format. Both the MCP
// server (add/remove tools, search-time lookup) and the relay console
// (list/add/delete endpoints) read and write the same file through this code
// — do not reimplement the schema elsewhere. Writes are atomic (tmp→rename)
// because two processes share the file. Best-effort persistence: a missing or
// corrupt file just means an empty store.
// ---------------------------------------------------------------------------
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type SearchAnnotation = {
  keyword: string; // original spelling, as given by the caller
  keywordKey: string; // normalized lookup key: lowercase, all whitespace removed
  projectKey: string;
  nodeId: string;
  nodeName: string;
  note?: string;
  addedAt: string; // ISO timestamp
};

export const ANNOTATIONS_FILE = path.join(
  os.homedir(),
  ".talk-to-figma",
  "index",
  "annotations.json"
);

// Same normalization as search matching: lowercase + strip all whitespace,
// so "Gym Chat", "gymchat" and "GymChat" share one key.
export function normalizeKeywordKey(keyword: string): string {
  return keyword.toLowerCase().replace(/\s+/g, "");
}

export function loadSearchAnnotations(): SearchAnnotation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ANNOTATIONS_FILE, "utf8"));
    if (Array.isArray(raw?.annotations)) {
      return raw.annotations.filter(
        (a: any) =>
          a &&
          typeof a.keywordKey === "string" &&
          typeof a.projectKey === "string" &&
          typeof a.nodeId === "string"
      );
    }
  } catch (error) {
    // Missing/corrupt annotations file is fine — start empty.
  }
  return [];
}

export function saveSearchAnnotations(annotations: SearchAnnotation[]): void {
  const dir = path.dirname(ANNOTATIONS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: the MCP server and the relay share this file.
  const tmp = path.join(dir, `.annotations.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ annotations }, null, 2));
  fs.renameSync(tmp, ANNOTATIONS_FILE);
}

// Add or update (same keywordKey+projectKey+nodeId updates in place).
// Returns the stored annotation.
export function upsertSearchAnnotation(input: {
  keyword: string;
  projectKey: string;
  nodeId: string;
  nodeName: string;
  note?: string;
}): SearchAnnotation {
  const annotations = loadSearchAnnotations();
  const keywordKey = normalizeKeywordKey(input.keyword);
  const annotation: SearchAnnotation = {
    keyword: input.keyword,
    keywordKey,
    projectKey: input.projectKey,
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    ...(input.note ? { note: input.note } : {}),
    addedAt: new Date().toISOString(),
  };
  const idx = annotations.findIndex(
    (a) =>
      a.keywordKey === keywordKey &&
      a.projectKey === input.projectKey &&
      a.nodeId === input.nodeId
  );
  if (idx !== -1) annotations[idx] = annotation;
  else annotations.push(annotation);
  saveSearchAnnotations(annotations);
  return annotation;
}

// Remove annotations for a keyword (all of them, or just one nodeId).
// Returns how many were removed.
export function removeSearchAnnotations(input: {
  keyword: string;
  projectKey: string;
  nodeId?: string;
}): number {
  const annotations = loadSearchAnnotations();
  const keywordKey = normalizeKeywordKey(input.keyword);
  const kept = annotations.filter(
    (a) =>
      !(
        a.keywordKey === keywordKey &&
        a.projectKey === input.projectKey &&
        (!input.nodeId || a.nodeId === input.nodeId)
      )
  );
  const removed = annotations.length - kept.length;
  if (removed > 0) saveSearchAnnotations(kept);
  return removed;
}

// Lookup annotations whose normalized key equals any of the given keys,
// scoped to one project.
export function findAnnotationsForKeys(
  projectKey: string,
  keys: string[]
): SearchAnnotation[] {
  if (!keys.length) return [];
  const keySet = new Set(keys);
  return loadSearchAnnotations().filter(
    (a) => a.projectKey === projectKey && keySet.has(a.keywordKey)
  );
}
