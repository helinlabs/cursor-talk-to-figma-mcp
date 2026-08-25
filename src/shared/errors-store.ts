// ---------------------------------------------------------------------------
// Relay error ledger — a persistent, bounded record of everything that went
// wrong across the pipeline (indexer steps, relayed plugin command errors and
// timeouts, /script/run failures, relay-internal exceptions), so recurring
// errors can be reviewed and turned into improvements instead of scrolling
// past in logs.
//
// Same sharing model as annotations-store: the relay WRITES, the relay's HTTP
// API and the MCP server (list_relay_errors) READ the shared disk file — both
// processes run on the same machine. Writes are atomic (tmp→rename).
// Best-effort persistence: a missing or corrupt file just means an empty
// ledger.
//
// Bounded two ways:
//   - ring buffer of at most 500 entries (oldest dropped)
//   - CONSECUTIVE identical (source, message, pageId) entries collapse into
//     one entry with an incremented `count` (spam guard for a tight loop
//     failing the same way), keeping `ts` of the first and `lastTs` of the
//     latest occurrence.
// ---------------------------------------------------------------------------
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type RelayErrorSource = "indexer" | "command" | "script" | "relay";

export type RelayErrorEntry = {
  ts: string; // ISO timestamp of the FIRST occurrence
  source: RelayErrorSource;
  project?: string;
  pageId?: string;
  pageName?: string;
  command?: string;
  message: string;
  detail?: string;
  count?: number; // present (>= 2) when consecutive identical entries collapsed
  lastTs?: string; // ISO timestamp of the LATEST occurrence when collapsed
};

export const ERRORS_FILE = path.join(os.homedir(), ".talk-to-figma", "errors.json");

const MAX_ENTRIES = 500;

const VALID_SOURCES: ReadonlySet<string> = new Set(["indexer", "command", "script", "relay"]);

function loadRaw(): RelayErrorEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ERRORS_FILE, "utf8"));
    if (Array.isArray(raw?.errors)) {
      return raw.errors.filter(
        (e: any) =>
          e &&
          typeof e.ts === "string" &&
          typeof e.message === "string" &&
          VALID_SOURCES.has(e.source)
      );
    }
  } catch {
    // Missing/corrupt ledger is fine — start empty.
  }
  return [];
}

function saveRaw(errors: RelayErrorEntry[]): void {
  const dir = path.dirname(ERRORS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: the MCP server reads this file while the relay writes it.
  const tmp = path.join(dir, `.errors.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ errors }, null, 2));
  fs.renameSync(tmp, ERRORS_FILE);
}

// Append one error (oldest-first on disk). Consecutive duplicates — same
// (source, message, pageId) as the newest stored entry — only bump its count.
export function recordRelayError(input: {
  source: RelayErrorSource;
  message: string;
  project?: string;
  pageId?: string;
  pageName?: string;
  command?: string;
  detail?: string;
}): void {
  try {
    const message = String(input.message || "").slice(0, 2000);
    if (!message) return;
    const errors = loadRaw();
    const now = new Date().toISOString();
    const last = errors[errors.length - 1];
    if (
      last &&
      last.source === input.source &&
      last.message === message &&
      (last.pageId ?? undefined) === (input.pageId ?? undefined)
    ) {
      last.count = (last.count ?? 1) + 1;
      last.lastTs = now;
      if (input.detail) last.detail = String(input.detail).slice(0, 4000);
    } else {
      errors.push({
        ts: now,
        source: input.source,
        message,
        ...(input.project ? { project: input.project } : {}),
        ...(input.pageId ? { pageId: input.pageId } : {}),
        ...(input.pageName ? { pageName: input.pageName } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.detail ? { detail: String(input.detail).slice(0, 4000) } : {}),
      });
      while (errors.length > MAX_ENTRIES) errors.shift();
    }
    saveRaw(errors);
  } catch (err) {
    // The ledger must never break the operation it is recording about.
    console.error("Could not record relay error:", err);
  }
}

// Read the ledger, NEWEST first. Optionally filter by source and cap count.
export function loadRelayErrors(opts?: {
  limit?: number;
  source?: RelayErrorSource | string;
}): RelayErrorEntry[] {
  let errors = loadRaw().slice().reverse();
  if (opts?.source) errors = errors.filter((e) => e.source === opts.source);
  const limit = Math.max(1, Math.min(Number(opts?.limit) || 100, MAX_ENTRIES));
  return errors.slice(0, limit);
}

export function clearRelayErrors(): number {
  const count = loadRaw().length;
  try {
    saveRaw([]);
  } catch (err) {
    console.error("Could not clear relay errors:", err);
  }
  return count;
}

// Compact summary for /health: how many errors in the last 24h (collapsed
// entries count once) and when the latest one happened.
export function summarizeRelayErrors(): { recentCount: number; lastAt: string | null } {
  const errors = loadRaw();
  const cutoff = Date.now() - 24 * 3600_000;
  let recentCount = 0;
  let lastAt: string | null = null;
  for (const e of errors) {
    const latest = e.lastTs ?? e.ts;
    const t = Date.parse(latest);
    if (Number.isFinite(t) && t >= cutoff) recentCount++;
    if (!lastAt || latest > lastAt) lastAt = latest;
  }
  return { recentCount, lastAt };
}
