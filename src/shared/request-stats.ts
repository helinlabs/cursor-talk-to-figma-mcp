// ---------------------------------------------------------------------------
// Request statistics.
//
// The relay saw every request and remembered none of them: it tracked what was
// in flight and forgot each one the moment it finished. So "which tool is slow"
// and "has this always been slow" had no answer, and an improvement request had
// nothing to argue from.
//
// This keeps daily aggregates rather than a log. A log of every call would be
// the more flexible thing and also the thing nobody prunes; aggregates answer
// the questions actually asked — which command is slow, on which project, for
// whom, and is that new — at a size that can sit on disk for months.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const STATS_PATH = process.env.RELAY_STATS_PATH
  || `${homedir()}/.talk-to-figma/request-stats.json`;
const KEEP_DAYS = Number(process.env.RELAY_STATS_KEEP_DAYS || 60);
const FLUSH_MS = Number(process.env.RELAY_STATS_FLUSH_MS || 30_000);

// Durations land in one of these instead of being stored individually, which is
// what lets a month of traffic stay small enough to keep. The edges are chosen
// around what these commands actually do: a metadata read, a page load, an
// export, and "something is wrong".
const BUCKET_EDGES = [100, 500, 2_000, 10_000, 30_000];
const BUCKET_LABELS = ["<100ms", "<500ms", "<2s", "<10s", "<30s", "30s+"];

export type Outcome = "ok" | "error" | "timeout" | "disconnected";

type Bucketed = {
  n: number;
  ok: number;
  error: number;
  timeout: number;
  disconnected: number;
  sumMs: number;
  maxMs: number;
  sumWaitMs: number;
  buckets: number[];
};

type Day = {
  commands: Record<string, Bucketed>;    // key: "<project> <command>"
  requesters: Record<string, Bucketed>;  // key: "<project> <requesterId>"
};

type Store = { version: number; days: Record<string, Day> };

const SEP = " ";

function blank(): Bucketed {
  return {
    n: 0, ok: 0, error: 0, timeout: 0, disconnected: 0,
    sumMs: 0, maxMs: 0, sumWaitMs: 0,
    buckets: new Array(BUCKET_LABELS.length).fill(0),
  };
}

function load(): Store {
  try {
    const parsed = JSON.parse(readFileSync(STATS_PATH, "utf8"));
    if (parsed && parsed.version === 1 && parsed.days) return parsed;
  } catch {}
  return { version: 1, days: {} };
}

let store = load();
let dirty = false;

// Bucket by KST day, so a "day" here matches the day the team had.
const dayKey = (at: number) => new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);

function bucketFor(ms: number): number {
  for (let index = 0; index < BUCKET_EDGES.length; index++) {
    if (ms < BUCKET_EDGES[index]) return index;
  }
  return BUCKET_EDGES.length;
}

function bump(target: Record<string, Bucketed>, key: string, ms: number, waitMs: number, outcome: Outcome): void {
  const entry = (target[key] ??= blank());
  entry.n += 1;
  entry[outcome] += 1;
  entry.sumMs += ms;
  entry.sumWaitMs += waitMs;
  if (ms > entry.maxMs) entry.maxMs = ms;
  entry.buckets[bucketFor(ms)] += 1;
}

export function recordRequest(input: {
  project: string;
  command: string;
  requesterId: string;
  totalMs: number;
  waitMs: number;
  outcome: Outcome;
  at?: number;
}): void {
  const at = input.at ?? Date.now();
  const day = (store.days[dayKey(at)] ??= { commands: {}, requesters: {} });
  bump(day.commands, `${input.project}${SEP}${input.command}`, input.totalMs, input.waitMs, input.outcome);
  bump(day.requesters, `${input.project}${SEP}${input.requesterId}`, input.totalMs, input.waitMs, input.outcome);
  dirty = true;
}

function prune(): void {
  const keys = Object.keys(store.days).sort();
  while (keys.length > KEEP_DAYS) {
    const oldest = keys.shift();
    if (oldest) delete store.days[oldest];
  }
}

export function flushStats(): void {
  if (!dirty) return;
  try {
    prune();
    mkdirSync(dirname(STATS_PATH), { recursive: true });
    // Write then rename: a relay killed mid-write must not leave a truncated
    // file that loses the whole history on the next boot.
    const staging = `${STATS_PATH}.tmp`;
    writeFileSync(staging, JSON.stringify(store));
    renameSync(staging, STATS_PATH);
    dirty = false;
  } catch (error) {
    console.error("[stats] could not persist:", error);
  }
}

setInterval(flushStats, FLUSH_MS).unref?.();

// --- reading ---------------------------------------------------------------
function merge(into: Bucketed, from: Bucketed): void {
  into.n += from.n;
  into.ok += from.ok;
  into.error += from.error;
  into.timeout += from.timeout;
  into.disconnected += from.disconnected;
  into.sumMs += from.sumMs;
  into.sumWaitMs += from.sumWaitMs;
  into.maxMs = Math.max(into.maxMs, from.maxMs);
  from.buckets.forEach((count, index) => { into.buckets[index] += count; });
}

// Buckets cannot give a real percentile, only the edge it falls inside. Saying
// "under 2s" is honest where a fabricated "1.7s" would not be.
function p95Bucket(entry: Bucketed): string {
  const target = entry.n * 0.95;
  let seen = 0;
  for (let index = 0; index < entry.buckets.length; index++) {
    seen += entry.buckets[index];
    if (seen >= target) return BUCKET_LABELS[index];
  }
  return BUCKET_LABELS[BUCKET_LABELS.length - 1];
}

function present(key: string, entry: Bucketed) {
  const separator = key.indexOf(SEP);
  const project = separator >= 0 ? key.slice(0, separator) : key;
  const subject = separator >= 0 ? key.slice(separator + 1) : "";
  return {
    project,
    subject,
    n: entry.n,
    ok: entry.ok,
    failed: entry.error + entry.timeout + entry.disconnected,
    errorRate: entry.n ? Number(((entry.n - entry.ok) / entry.n).toFixed(3)) : 0,
    meanMs: entry.n ? Math.round(entry.sumMs / entry.n) : 0,
    meanWaitMs: entry.n ? Math.round(entry.sumWaitMs / entry.n) : 0,
    maxMs: entry.maxMs,
    p95: p95Bucket(entry),
    distribution: Object.fromEntries(BUCKET_LABELS.map((label, index) => [label, entry.buckets[index]])),
  };
}

export function summarize(options: { days?: number; project?: string; limit?: number } = {}) {
  const days = Math.max(1, options.days ?? 7);
  const wanted = Object.keys(store.days).sort().slice(-days);
  const commands: Record<string, Bucketed> = {};
  const requesters: Record<string, Bucketed> = {};
  for (const day of wanted) {
    const bucket = store.days[day];
    if (!bucket) continue;
    for (const [key, entry] of Object.entries(bucket.commands)) {
      if (options.project && !key.startsWith(`${options.project}${SEP}`)) continue;
      merge((commands[key] ??= blank()), entry);
    }
    for (const [key, entry] of Object.entries(bucket.requesters)) {
      if (options.project && !key.startsWith(`${options.project}${SEP}`)) continue;
      merge((requesters[key] ??= blank()), entry);
    }
  }
  const limit = options.limit ?? 20;
  const rows = (source: Record<string, Bucketed>) =>
    Object.entries(source).map(([key, entry]) => present(key, entry));
  return {
    days: wanted,
    // Ranked by mean, not by count: the question this exists to answer is which
    // tool is slow, not which one is popular. Both lists are returned so the
    // second question is still one field away.
    slowestCommands: rows(commands).filter((row) => row.n >= 3).sort((a, b) => b.meanMs - a.meanMs).slice(0, limit),
    busiestCommands: rows(commands).sort((a, b) => b.n - a.n).slice(0, limit),
    requesters: rows(requesters).sort((a, b) => b.n - a.n).slice(0, limit),
  };
}

// Day by day for one command, which is what answers "has this always been slow"
// when someone asks for it to be made faster.
export function history(command: string, options: { days?: number; project?: string } = {}) {
  const days = Math.max(1, options.days ?? 30);
  return Object.keys(store.days).sort().slice(-days).map((day) => {
    const totals = blank();
    for (const [key, entry] of Object.entries(store.days[day]?.commands ?? {})) {
      const separator = key.indexOf(SEP);
      const project = key.slice(0, separator);
      const name = key.slice(separator + 1);
      if (name !== command) continue;
      if (options.project && project !== options.project) continue;
      merge(totals, entry);
    }
    return { day, ...present(`${options.project ?? "*"}${SEP}${command}`, totals) };
  }).filter((row) => row.n > 0);
}
