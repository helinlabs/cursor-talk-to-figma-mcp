#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { createHash, randomUUID } from "crypto";
import * as path from "path";
import {
  loadSearchAnnotations,
  upsertSearchAnnotation,
  removeSearchAnnotations,
} from "./shared/annotations-store";
import {
  INDEX_DIR,
  loadProjectIndex,
  saveProjectIndex,
  listProjectIndexSummaries,
  type ProjectIndex,
} from "./shared/search-index";

const PROTOCOL_VERSION = "2.2.0";

function isProtocolCompatible(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const expectedMajor = Number(PROTOCOL_VERSION.split(".")[0]);
  const receivedMajor = Number(version.split(".")[0]);
  return Number.isInteger(receivedMajor) && receivedMajor === expectedMajor;
}

function protocolMismatchMessage(received: unknown): string {
  return `Talk-to-Figma protocol mismatch: relay=${PROTOCOL_VERSION}, client=${received || "missing"}. Update/rebuild the MCP server and re-run the Figma development plugin, then reconnect.`;
}

// Build id served to the plugin UI (GET /plugin-version): a content hash of the
// on-disk plugin files. Lets the plugin show which code is loaded WITHOUT
// baking a version into the source (nothing committed per build). Computed per
// request so edits are reflected without restarting the relay.
function pluginVersion(): string {
  try {
    const code = readFileSync(new URL("./cursor_mcp_plugin/code.js", import.meta.url), "utf8");
    const ui = readFileSync(new URL("./cursor_mcp_plugin/ui.html", import.meta.url), "utf8")
      // neutralize the build-id span so it can't affect its own hash
      .replace(/(<span id="build-id">)(.*?)(<\/span>)/, "$1$3");
    return createHash("sha256").update(code).update(ui).digest("hex").slice(0, 7);
  } catch (e) {
    return "unknown";
  }
}

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// ---------------------------------------------------------------------------
// Monitoring / Web console state
// ---------------------------------------------------------------------------

interface ClientMeta {
  id: string;
  role: "unknown" | "controller" | "figma" | "monitor";
  channel: string | null;
  connectedAt: number;
  lastSeenAt: number;
  isMonitor: boolean;
  lastCommand?: string;
  requesterId?: string;
  activeRequests: number;
  recentTimeouts: boolean[];
  unstable: boolean;
  applicationHeartbeat: boolean;
  protocolVersion?: string;
  protocolVerified: boolean;
}

interface RequestMeta {
  id: string;
  channel: string;
  command: string;
  // null for relay-internal requests (indexer); results go to onInternalResult.
  requester: ServerWebSocket<any> | null;
  requesterId: string;
  figma?: ServerWebSocket<any>;
  queuedAt: number;
  dispatchedAt?: number;
  startedAt?: number;
  batchId?: string;
  onInternalResult?: (message: { id: string; result?: any; error?: any }) => void;
}

// Per-socket metadata (id, inferred role, current channel, …)
const clientMeta = new Map<ServerWebSocket<any>, ClientMeta>();

// Sockets that opened the web console and want the live event stream
const monitors = new Set<ServerWebSocket<any>>();
const requests = new Map<string, RequestMeta>();
const bulkJobs = new Map<string, any>();

// Ring buffer of recent events so a freshly-opened console sees history.
// The browser console keeps a much larger buffer; this is just the backlog
// handed to a console when it first connects.
const eventLog: any[] = [];
const MAX_LOG = 1000;

let clientSeq = 0;

// Channels that have gone empty are kept around (so the console can show a
// history of past sessions) but capped so they don't grow unbounded.
// name -> timestamp it became empty
const emptyChannels = new Map<string, number>();
const MAX_EMPTY = 50;

// name -> document identity announced by the Figma plugin on that channel
const channelDocs = new Map<string, any>();
const channelAnnouncedAt = new Map<string, number>();

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const UNSTABLE_WINDOW = 10;
const UNSTABLE_TIMEOUT_RATE = 0.5;

function touch(ws: ServerWebSocket<any>): void {
  const meta = clientMeta.get(ws);
  if (meta) meta.lastSeenAt = Date.now();
}

function recordFigmaOutcome(ws: ServerWebSocket<any> | undefined, timedOut: boolean): void {
  if (!ws) return;
  const meta = clientMeta.get(ws);
  if (!meta) return;
  meta.recentTimeouts.push(timedOut);
  if (meta.recentTimeouts.length > UNSTABLE_WINDOW) meta.recentTimeouts.shift();
  const rate = meta.recentTimeouts.filter(Boolean).length / meta.recentTimeouts.length;
  meta.unstable = meta.recentTimeouts.length >= UNSTABLE_WINDOW && rate >= UNSTABLE_TIMEOUT_RATE;
  if (meta.unstable) {
    pushEvent({ kind: "unstable", clientId: meta.id, channel: meta.channel, timeoutRate: rate });
    ws.close(4002, "Figma connection classified as unstable");
  }
}

function leaveChannel(ws: ServerWebSocket<any>, channelName: string): void {
  const clients = channels.get(channelName);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) {
    emptyChannels.set(channelName, Date.now());
    pruneEmptyChannels();
  }
}

function chooseFigma(channelName: string): ServerWebSocket<any> | undefined {
  return [...(channels.get(channelName) ?? [])]
    .filter((client) => {
      const meta = clientMeta.get(client);
      return client.readyState === WebSocket.OPEN && meta?.role === "figma" && !meta.unstable;
    })
    .sort((a, b) => {
      const am = clientMeta.get(a)!;
      const bm = clientMeta.get(b)!;
      return am.activeRequests - bm.activeRequests || bm.connectedAt - am.connectedAt;
    })[0];
}

function pruneEmptyChannels(): void {
  if (emptyChannels.size <= MAX_EMPTY) return;
  const oldestFirst = [...emptyChannels.entries()].sort((a, b) => a[1] - b[1]);
  while (emptyChannels.size > MAX_EMPTY) {
    const [name] = oldestFirst.shift()!;
    emptyChannels.delete(name);
    channels.delete(name);
    channelDocs.delete(name);
  }
}

// Load the web console HTML once at startup (served at GET /console and /)
let CONSOLE_HTML = "<h1>console.html not found</h1>";
try {
  CONSOLE_HTML = await Bun.file(new URL("./console.html", import.meta.url)).text();
} catch (err) {
  console.error("Could not load console.html:", err);
}

// Truncate large payloads before they go into the log / monitor stream so the
// console stays responsive even with big get_document_info style responses.
function truncate(value: unknown, max = 4000): unknown {
  if (value === undefined || value === null) return value;
  let str: string;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (str.length <= max) return value;
  return { __truncated: true, length: str.length, preview: str.slice(0, max) };
}

function pushEvent(evt: any): void {
  evt.ts = evt.ts ?? Date.now();
  eventLog.push(evt);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  const data = JSON.stringify({ kind: "event", event: evt });
  monitors.forEach((m) => {
    if (m.readyState === WebSocket.OPEN) m.send(data);
  });
}

function snapshotChannels(): any[] {
  const out: any[] = [];
  channels.forEach((clients, name) => {
    const members: any[] = [];
    clients.forEach((c) => {
      const m = clientMeta.get(c);
      if (m) members.push({
        id: m.id,
        role: m.role,
        connectedAt: m.connectedAt,
        lastSeenAt: m.lastSeenAt,
        requesterId: m.requesterId ?? null,
        activeRequests: m.activeRequests,
        unstable: m.unstable,
        protocolVersion: m.protocolVersion ?? null,
      });
    });
    out.push({
      channel: name,
      count: members.length,
      clients: members,
      empty: members.length === 0,
      emptiedAt: emptyChannels.get(name) ?? null,
      document: channelDocs.get(name) ?? null,
      announcedAt: channelAnnouncedAt.get(name) ?? null,
      queueDepth: members.reduce((sum, member) => sum + (member.activeRequests || 0), 0),
    });
  });
  return out;
}

function snapshotProjects(): any[] {
  const groups = new Map<string, any[]>();
  for (const channel of snapshotChannels()) {
    if (!channel.document) continue;
    const key = channel.document.fileKey || channel.document.documentName || channel.channel;
    const list = groups.get(key) ?? [];
    list.push(channel);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([projectKey, connections]) => {
    const live = connections.filter((connection) =>
      connection.clients.some((client: any) => client.role === "figma" && !client.unstable)
    );
    const newest = [...live].sort((a, b) => (b.announcedAt || 0) - (a.announcedAt || 0))[0] ?? null;
    const leastLoaded = [...live].sort((a, b) => {
      const ac = a.clients.filter((client: any) => client.role === "controller").length;
      const bc = b.clients.filter((client: any) => client.role === "controller").length;
      return ac - bc || a.queueDepth - b.queueDepth || (b.announcedAt || 0) - (a.announcedAt || 0);
    })[0] ?? null;
    const document = (newest || connections[0]).document;
    return {
      projectKey,
      name: document.documentName,
      fileKey: document.fileKey ?? null,
      connectionCount: live.length,
      totalConnectionCount: connections.length,
      representativeChannel: newest?.channel ?? null,
      recommendedChannel: leastLoaded?.channel ?? null,
      busy: live.reduce((sum, connection) => sum + connection.queueDepth, 0),
      connections,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function pushChannels(): void {
  const data = JSON.stringify({
    kind: "channels",
    protocolVersion: PROTOCOL_VERSION,
    channels: snapshotChannels(),
    projects: snapshotProjects(),
    bulkJobs: [...bulkJobs.values()],
  });
  monitors.forEach((m) => {
    if (m.readyState === WebSocket.OPEN) m.send(data);
  });
}

// ---------------------------------------------------------------------------
// Relay-internal commands: the relay itself acts as a controller and sends a
// command to the plugin of a channel, resolving on the response. Used by the
// incremental indexer and console helpers. Uses the same RequestMeta pipeline
// as real controllers, so queueDepth accounting and stability tracking apply.
// ---------------------------------------------------------------------------

function sendInternalCommand(
  channelName: string,
  command: string,
  params: any = {},
  timeoutMs = 30_000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const figma = chooseFigma(channelName);
    if (!figma) {
      reject(new Error(`No healthy Figma plugin on channel "${channelName}"`));
      return;
    }
    const figmaMeta = clientMeta.get(figma)!;
    const id = randomUUID();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      requests.delete(id);
      figmaMeta.activeRequests = Math.max(0, figmaMeta.activeRequests - 1);
      recordFigmaOutcome(figma, true);
      reject(new Error(`Internal command ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const request: RequestMeta = {
      id,
      channel: channelName,
      command,
      requester: null,
      requesterId: "relay-internal",
      figma,
      queuedAt: Date.now(),
      dispatchedAt: Date.now(),
      onInternalResult: (message) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (message.error !== undefined && message.error !== null) {
          reject(new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error)));
        } else {
          resolve(message.result);
        }
      },
    };
    requests.set(id, request);
    figmaMeta.activeRequests++;
    figma.send(JSON.stringify({
      type: "broadcast",
      message: { id, command, params },
      sender: "relay-internal",
      channel: channelName,
    }));
  });
}

// Total in-flight requests on a channel's Figma plugin(s), i.e. real user
// traffic the indexer must yield to.
function channelQueueDepth(channelName: string): number {
  let depth = 0;
  for (const client of channels.get(channelName) ?? []) {
    const m = clientMeta.get(client);
    if (m?.role === "figma") depth += m.activeRequests;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Incremental background indexer.
//
// Scans every live project page-by-page (one `dump_page_index` plugin command
// = one step) and persists the result to ~/.talk-to-figma/index/ so the MCP
// server's search_nodes can answer from disk. Never scans in one shot: scope
// is fixed at job start (live projects × list_pages), each step checkpoints a
// partial index + cursor to disk (progress.json), and a restart resumes from
// the cursor. Between steps the indexer sleeps briefly and defers any project
// whose channel has real traffic (queueDepth > 0), so live commands always
// interleave.
//
// Triggers: ① 60s after plugin announces settle (auto, once per relay run)
// ② daily at 04:00 KST ③ POST /index/rebuild (optionally ?project=).
// ---------------------------------------------------------------------------

const PROGRESS_FILE = path.join(INDEX_DIR, "progress.json");
const INDEX_STEP_IDLE_MS = 300; // idle gap between steps for live traffic
const INDEX_BUSY_RETRY_MS = 500; // wait when every channel is busy
const INDEX_STEP_TIMEOUT_MS = 30_000; // cold page load measured at <=11s

interface IndexProjectProgress {
  projectKey: string;
  name: string;
  pages: Array<{ id: string; name: string }>;
  nextIndex: number;
  failures: Array<{ pageId: string; pageName: string; error: string }>;
}

const indexer = {
  state: "idle" as "idle" | "running",
  trigger: null as string | null,
  startedAt: 0,
  scannedPages: 0,
  totalPages: 0,
  projects: [] as IndexProjectProgress[],
  currentStep: null as null | { projectKey: string; pageId: string; pageName: string },
  durations: [] as number[],
  lastError: null as string | null,
  lastCompletedAt: null as number | null,
  autoTriggered: false,
  autoTimer: null as ReturnType<typeof setTimeout> | null,
};

function loadIndexProgress(): { lastCompletedAt: number | null; projects: IndexProjectProgress[] } {
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
    return {
      lastCompletedAt: typeof raw.lastCompletedAt === "number" ? raw.lastCompletedAt : null,
      projects: Array.isArray(raw.projects) ? raw.projects : [],
    };
  } catch {
    return { lastCompletedAt: null, projects: [] };
  }
}

function saveIndexProgress(): void {
  try {
    mkdirSync(INDEX_DIR, { recursive: true });
    const tmp = `${PROGRESS_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      running: indexer.state === "running",
      startedAt: indexer.startedAt || null,
      lastCompletedAt: indexer.lastCompletedAt,
      projects: indexer.projects.map((p) => ({
        projectKey: p.projectKey,
        name: p.name,
        pages: p.pages,
        nextIndex: p.nextIndex,
        failures: p.failures,
      })),
    }, null, 2));
    renameSync(tmp, PROGRESS_FILE);
  } catch (err) {
    console.error("Could not persist index progress:", err);
  }
}

indexer.lastCompletedAt = loadIndexProgress().lastCompletedAt;

function resolveProjectChannel(projectKey: string): string | null {
  const project = snapshotProjects().find((p) => p.projectKey === projectKey);
  return project?.recommendedChannel ?? null;
}

function indexEta(): { avgPageMs: number | null; etaMs: number | null } {
  if (!indexer.durations.length) return { avgPageMs: null, etaMs: null };
  const avg = indexer.durations.reduce((a, b) => a + b, 0) / indexer.durations.length;
  const remaining = indexer.totalPages - indexer.scannedPages;
  return { avgPageMs: Math.round(avg), etaMs: Math.round(avg * Math.max(0, remaining)) };
}

function indexStatus(): any {
  const { avgPageMs, etaMs } = indexEta();
  return {
    state: indexer.state,
    trigger: indexer.trigger,
    startedAt: indexer.startedAt || null,
    elapsedMs: indexer.state === "running" ? Date.now() - indexer.startedAt : null,
    scannedPages: indexer.scannedPages,
    totalPages: indexer.totalPages,
    currentStep: indexer.currentStep,
    avgPageMs,
    etaMs,
    lastError: indexer.lastError,
    lastCompletedAt: indexer.lastCompletedAt,
    jobProjects: indexer.projects.map((p) => ({
      projectKey: p.projectKey,
      name: p.name,
      totalPages: p.pages.length,
      scannedPages: p.nextIndex,
      failures: p.failures,
    })),
    // What is on disk (survives restarts), independent of the current job.
    diskIndexes: listProjectIndexSummaries(),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function startIndexJob(opts: { trigger: string; projectFilter?: string; resume?: boolean }): { started: boolean; reason?: string } {
  if (indexer.state === "running") return { started: false, reason: "an index job is already running" };
  const live = snapshotProjects().filter((p) => p.connectionCount > 0 && p.recommendedChannel);
  let scope = live;
  if (opts.projectFilter) {
    const f = opts.projectFilter.toLowerCase();
    scope = live.filter((p) => p.projectKey === opts.projectFilter || String(p.name || "").toLowerCase().includes(f));
  }
  if (!scope.length) return { started: false, reason: "no live matching Figma projects" };

  indexer.state = "running";
  indexer.trigger = opts.trigger;
  indexer.startedAt = Date.now();
  indexer.scannedPages = 0;
  indexer.totalPages = 0;
  indexer.projects = [];
  indexer.currentStep = null;
  indexer.durations = [];
  indexer.lastError = null;

  const resumable = opts.resume ? loadIndexProgress().projects.filter((p) => p.nextIndex < (p.pages?.length ?? 0)) : [];

  void (async () => {
    try {
      // Fix the scope: enumerate pages per live project (resume uses the
      // checkpointed page list + cursor instead of a fresh listing).
      for (const project of scope) {
        const saved = resumable.find((p) => p.projectKey === project.projectKey);
        if (saved) {
          indexer.projects.push({ ...saved, name: project.name || saved.name, failures: saved.failures ?? [] });
          continue;
        }
        try {
          const listing = await sendInternalCommand(project.recommendedChannel, "list_pages", { withChildCounts: false }, INDEX_STEP_TIMEOUT_MS);
          indexer.projects.push({
            projectKey: project.projectKey,
            name: project.name || project.projectKey,
            pages: (listing?.pages || []).map((p: any) => ({ id: p.id, name: p.name })),
            nextIndex: 0,
            failures: [],
          });
        } catch (err) {
          indexer.projects.push({
            projectKey: project.projectKey,
            name: project.name || project.projectKey,
            pages: [],
            nextIndex: 0,
            failures: [{ pageId: "-", pageName: "(list_pages)", error: err instanceof Error ? err.message : String(err) }],
          });
        }
      }
      indexer.totalPages = indexer.projects.reduce((sum, p) => sum + p.pages.length, 0);
      saveIndexProgress();
      pushEvent({ kind: "index_job", status: "started", trigger: opts.trigger, totalPages: indexer.totalPages, projects: indexer.projects.map((p) => p.name) });

      // In-memory working copies of the project index files.
      const working = new Map<string, ProjectIndex>();
      const getWorking = (p: IndexProjectProgress): ProjectIndex => {
        let idx = working.get(p.projectKey);
        if (!idx) {
          idx = loadProjectIndex(p.projectKey) ?? {
            projectKey: p.projectKey,
            projectName: p.name,
            builtAt: null,
            updatedAt: 0,
            pageCount: 0,
            nodeCount: 0,
            pages: [],
          };
          idx.projectName = p.name;
          working.set(p.projectKey, idx);
        }
        return idx;
      };

      while (true) {
        const pending = indexer.projects.filter((p) => p.nextIndex < p.pages.length);
        if (!pending.length) break;
        // Pick the first pending project whose channel is live AND idle;
        // busy channels are deferred so real traffic goes first.
        let pick: { p: IndexProjectProgress; channel: string } | null = null;
        let anyLive = false;
        for (const p of pending) {
          const channel = resolveProjectChannel(p.projectKey);
          if (!channel) continue;
          anyLive = true;
          if (channelQueueDepth(channel) > 0) continue;
          pick = { p, channel };
          break;
        }
        if (!pick) {
          if (!anyLive) {
            indexer.lastError = "no live Figma plugin remains for the pending projects; job suspended (will resume on the next trigger)";
            break;
          }
          await sleep(INDEX_BUSY_RETRY_MS);
          continue;
        }
        const page = pick.p.pages[pick.p.nextIndex];
        indexer.currentStep = { projectKey: pick.p.projectKey, pageId: page.id, pageName: page.name };
        const t0 = Date.now();
        try {
          const dump = await sendInternalCommand(pick.channel, "dump_page_index", { pageId: page.id }, INDEX_STEP_TIMEOUT_MS);
          const idx = getWorking(pick.p);
          const pageIndex = {
            pageId: dump.pageId,
            pageName: dump.pageName,
            builtAt: dump.builtAt ?? Date.now(),
            nodeCount: dump.nodeCount ?? (dump.entries?.length || 0),
            entries: dump.entries || [],
          };
          const existing = idx.pages.findIndex((pg) => pg.pageId === pageIndex.pageId);
          if (existing !== -1) idx.pages[existing] = pageIndex;
          else idx.pages.push(pageIndex);
          saveProjectIndex(idx); // checkpoint: partial index survives restarts
        } catch (err) {
          pick.p.failures.push({ pageId: page.id, pageName: page.name, error: err instanceof Error ? err.message : String(err) });
        }
        indexer.durations.push(Date.now() - t0);
        pick.p.nextIndex++;
        indexer.scannedPages++;
        if (pick.p.nextIndex >= pick.p.pages.length) {
          // Project finished: stamp builtAt and drop pages that no longer exist.
          const idx = getWorking(pick.p);
          const liveIds = new Set(pick.p.pages.map((pg) => pg.id));
          idx.pages = idx.pages.filter((pg) => liveIds.has(pg.pageId));
          idx.builtAt = Date.now();
          saveProjectIndex(idx);
          pushEvent({ kind: "index_project_done", projectKey: pick.p.projectKey, name: pick.p.name, pages: idx.pages.length, nodes: idx.nodeCount, failures: pick.p.failures.length });
        }
        saveIndexProgress(); // checkpoint the cursor after EVERY step
        indexer.currentStep = null;
        await sleep(INDEX_STEP_IDLE_MS);
      }
      if (!indexer.lastError) indexer.lastCompletedAt = Date.now();
      pushEvent({ kind: "index_job", status: indexer.lastError ? "suspended" : "completed", trigger: opts.trigger, scannedPages: indexer.scannedPages, totalPages: indexer.totalPages, error: indexer.lastError });
    } catch (err) {
      indexer.lastError = err instanceof Error ? err.message : String(err);
      pushEvent({ kind: "index_job", status: "failed", trigger: opts.trigger, error: indexer.lastError });
    } finally {
      indexer.state = "idle";
      indexer.currentStep = null;
      saveIndexProgress();
    }
  })();

  return { started: true };
}

// Trigger ①: auto-start 60s after the last plugin announce (i.e. once the set
// of connected files has settled), once per relay run. Also resumes any job
// that was interrupted by a relay restart (checkpointed cursor).
const AUTO_INDEX_SETTLE_MS = 60_000;
function armAutoIndex(): void {
  if (indexer.autoTriggered) return;
  if (indexer.autoTimer) clearTimeout(indexer.autoTimer);
  indexer.autoTimer = setTimeout(() => {
    if (indexer.autoTriggered || indexer.state === "running") return;
    const result = startIndexJob({ trigger: "startup", resume: true });
    if (result.started) indexer.autoTriggered = true;
  }, AUTO_INDEX_SETTLE_MS);
}

// Trigger ②: daily at 04:00 KST (Asia/Seoul is fixed UTC+9, no DST).
function scheduleDailyIndex(): void {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 3600_000);
  const next = new Date(kstNow);
  next.setUTCHours(4, 0, 0, 0); // 04:00 in the shifted (KST-as-UTC) frame
  if (next.getTime() <= kstNow.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next.getTime() - kstNow.getTime();
  setTimeout(() => {
    startIndexJob({ trigger: "daily-0400kst", resume: true });
    scheduleDailyIndex();
  }, delay);
}
scheduleDailyIndex();

// ---------------------------------------------------------------------------

function handleConnection(ws: ServerWebSocket<any>) {
  const meta: ClientMeta = {
    id: `c${++clientSeq}`,
    role: "unknown",
    channel: null,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    isMonitor: false,
    activeRequests: 0,
    recentTimeouts: [],
    unstable: false,
    applicationHeartbeat: false,
    protocolVerified: false,
  };
  clientMeta.set(ws, meta);

  console.log(`New client connected (${meta.id})`);

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));

  pushEvent({ kind: "connect", clientId: meta.id });
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 3055,
  hostname: process.env.HOST || "127.0.0.1",
  // uncomment this to allow connections in windows wsl
  // hostname: "0.0.0.0",
  async fetch(req: Request, server: Server) {
    const JSON_HEADERS = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    };
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Handle WebSocket upgrade first (clients connect to the root path).
    // For plain HTTP GETs this returns false and we fall through to serving
    // the web console below.
    const success = server.upgrade(req, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

    if (success) {
      return; // Upgraded to WebSocket
    }

    // Serve the monitoring web console for normal browser requests
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/console") {
      return new Response(CONSOLE_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // JSON list of channels + their document identity (for controllers/tools)
    if (url.pathname === "/channels") {
      return new Response(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, channels: snapshotChannels(), projects: snapshotProjects() }, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/projects") {
      return new Response(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, projects: snapshotProjects() }, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Lightweight liveness probe (for admin dashboards / monitoring).
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        index: { lastBuiltAt: indexer.lastCompletedAt, running: indexer.state === "running" },
      }), { headers: JSON_HEADERS });
    }

    // --- Background index: status / rebuild ---------------------------------
    if (url.pathname === "/index/status") {
      return new Response(JSON.stringify(indexStatus(), null, 2), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/index/rebuild" && req.method === "POST") {
      const project = url.searchParams.get("project") || undefined;
      const result = startIndexJob({ trigger: "manual", projectFilter: project });
      return new Response(JSON.stringify(result, null, 2), {
        status: result.started ? 202 : 409,
        headers: JSON_HEADERS,
      });
    }

    // Plugin-side page cache status for a project (on-demand, for the console).
    if (url.pathname === "/index/cache-status") {
      const projectKey = url.searchParams.get("project") || "";
      const channel = resolveProjectChannel(projectKey);
      if (!channel) {
        return new Response(JSON.stringify({ error: `No live Figma plugin for project "${projectKey}"` }), { status: 404, headers: JSON_HEADERS });
      }
      try {
        const status = await sendInternalCommand(channel, "get_search_cache_status", {}, 15_000);
        return new Response(JSON.stringify(status, null, 2), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 502, headers: JSON_HEADERS });
      }
    }

    // --- Keyword annotations (shared file with the MCP server) --------------
    if (url.pathname === "/search/annotations") {
      if (req.method === "GET") {
        return new Response(JSON.stringify({ annotations: loadSearchAnnotations() }, null, 2), { headers: JSON_HEADERS });
      }
      if (req.method === "POST") {
        try {
          const body: any = await req.json();
          const keyword = String(body?.keyword || "").trim();
          const projectKey = String(body?.projectKey || "").trim();
          const nodeId = String(body?.nodeId || "").trim();
          if (!keyword || !projectKey || !nodeId) {
            return new Response(JSON.stringify({ error: "keyword, projectKey and nodeId are required" }), { status: 400, headers: JSON_HEADERS });
          }
          // Best-effort node name lookup via the live plugin (optional).
          let nodeName = String(body?.nodeName || "");
          if (!nodeName) {
            const channel = resolveProjectChannel(projectKey);
            if (channel) {
              try {
                const info = await sendInternalCommand(channel, "get_node_info", { nodeId, fields: ["id"], maxDepth: 0 }, 15_000);
                nodeName = String(info?.name ?? "");
              } catch {}
            }
          }
          const annotation = upsertSearchAnnotation({ keyword, projectKey, nodeId, nodeName, note: body?.note ? String(body.note) : undefined });
          return new Response(JSON.stringify({ saved: true, annotation }, null, 2), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 400, headers: JSON_HEADERS });
        }
      }
      if (req.method === "DELETE") {
        const keyword = url.searchParams.get("keyword") || "";
        const projectKey = url.searchParams.get("projectKey") || "";
        const nodeId = url.searchParams.get("nodeId") || undefined;
        if (!keyword || !projectKey) {
          return new Response(JSON.stringify({ error: "keyword and projectKey query params are required" }), { status: 400, headers: JSON_HEADERS });
        }
        const removed = removeSearchAnnotations({ keyword, projectKey, nodeId });
        return new Response(JSON.stringify({ removed }, null, 2), { headers: JSON_HEADERS });
      }
    }

    if (url.pathname === "/status") {
      return new Response(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        projects: snapshotProjects(),
        requestsInFlight: requests.size,
        bulkJobs: [...bulkJobs.values()],
      }, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Build id of the on-disk plugin files (for the plugin UI's version badge).
    if (url.pathname === "/plugin-version") {
      return new Response(JSON.stringify({ build: pluginVersion(), protocolVersion: PROTOCOL_VERSION }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Return response for non-WebSocket requests
    return new Response("WebSocket server running", {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
  websocket: {
    open: handleConnection,
    pong(ws: ServerWebSocket<any>) {
      // For Figma, require the application-level heartbeat from the plugin UI.
      // A protocol pong can still arrive while a backgrounded UI is frozen.
      if (!clientMeta.get(ws)?.applicationHeartbeat) touch(ws);
    },
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        const data = JSON.parse(message as string);
        const meta = clientMeta.get(ws);
        touch(ws);

        if (data.type === "heartbeat") {
          if (meta) {
            if (data.requesterId) meta.requesterId = String(data.requesterId);
            if (data.role === "figma") meta.applicationHeartbeat = true;
          }
          ws.send(JSON.stringify({ type: "heartbeat_ack", ts: Date.now() }));
          return;
        }

        if (data.type === "hello") {
          if (meta) {
            meta.requesterId = data.requesterId ? String(data.requesterId) : meta.requesterId;
            if (data.role === "controller" || data.role === "figma") meta.role = data.role;
            if (data.role === "figma") meta.applicationHeartbeat = true;
            meta.protocolVersion = typeof data.protocolVersion === "string" ? data.protocolVersion : undefined;
            meta.protocolVerified = isProtocolCompatible(data.protocolVersion);
            if (!meta.protocolVerified) {
              const message = protocolMismatchMessage(data.protocolVersion);
              ws.send(JSON.stringify({
                type: "system",
                event: "protocol_mismatch",
                message,
                expectedProtocolVersion: PROTOCOL_VERSION,
                receivedProtocolVersion: data.protocolVersion ?? null,
              }));
              pushEvent({ kind: "protocol_mismatch", clientId: meta.id, requesterId: meta.requesterId, receivedProtocolVersion: data.protocolVersion ?? null, expectedProtocolVersion: PROTOCOL_VERSION });
              ws.close(4003, "Protocol version mismatch");
              return;
            }
          }
          pushChannels();
          return;
        }

        if (data.type === "bulk_status") {
          const job = { ...data.job, requesterId: meta?.requesterId ?? meta?.id, updatedAt: Date.now() };
          if (job.id) bulkJobs.set(job.id, job);
          pushEvent({ kind: "bulk", ...job });
          pushChannels();
          return;
        }

        if (data.type === "execution_started") {
          const request = requests.get(data.id);
          if (request && request.figma === ws) {
            request.startedAt = Date.now();
            pushEvent({
              kind: "started",
              clientId: meta?.id,
              requesterId: request.requesterId,
              channel: request.channel,
              commandId: request.id,
              command: request.command,
              waitMs: request.startedAt - request.queuedAt,
              batchId: request.batchId,
            });
          }
          return;
        }

        if (data.type === "request_timeout") {
          const request = requests.get(data.id);
          if (request && request.requester === ws) {
            const figmaMeta = request.figma ? clientMeta.get(request.figma) : undefined;
            if (figmaMeta) figmaMeta.activeRequests = Math.max(0, figmaMeta.activeRequests - 1);
            recordFigmaOutcome(request.figma, true);
            requests.delete(data.id);
            pushEvent({ kind: "timeout", requesterId: request.requesterId, clientId: figmaMeta?.id, channel: request.channel, commandId: request.id, command: request.command });
            pushChannels();
          }
          return;
        }

        // --- Monitoring console registration ---------------------------------
        if (data.type === "monitor") {
          if (meta) {
            meta.isMonitor = true;
            meta.role = "monitor";
          }
          monitors.add(ws);
          ws.send(JSON.stringify({
            kind: "snapshot",
            protocolVersion: PROTOCOL_VERSION,
            channels: snapshotChannels(),
            projects: snapshotProjects(),
            bulkJobs: [...bulkJobs.values()],
            log: eventLog,
          }));
          console.log(`\n👁  Monitor connected (${meta?.id})`);
          return;
        }

        // --- Console action: drop all empty (clientless) channels -----------
        if (data.type === "clear_empty") {
          let removed = 0;
          for (const [name, set] of channels) {
            if (set.size === 0) {
              channels.delete(name);
              emptyChannels.delete(name);
              channelDocs.delete(name);
              removed++;
            }
          }
          console.log(`\n🧹 Cleared ${removed} empty channel(s)`);
          pushChannels();
          return;
        }

        // --- Document identity announcement from the Figma plugin ------------
        if (data.type === "announce") {
          const channelName = data.channel;
          const channelClients = channels.get(channelName);
          if (!channelName || !channelClients || !channelClients.has(ws)) return;
          channelDocs.set(channelName, data.document);
          channelAnnouncedAt.set(channelName, Date.now());
          if (meta) meta.role = "figma"; // only the plugin announces a document
          console.log(`\n📄 Channel "${channelName}" → document:`, JSON.stringify(data.document));
          pushEvent({ kind: "document", clientId: meta?.id, channel: channelName, document: data.document });
          pushChannels();
          armAutoIndex(); // (re)arm the settle timer for the auto index build
          return;
        }

        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || 'N/A'}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Full message:`, JSON.stringify(data, null, 2));

        if (data.type === "join") {
          if (!meta?.protocolVerified) {
            const message = protocolMismatchMessage(meta?.protocolVersion);
            ws.send(JSON.stringify({
              type: "system",
              event: "protocol_mismatch",
              message,
              expectedProtocolVersion: PROTOCOL_VERSION,
              receivedProtocolVersion: meta?.protocolVersion ?? null,
            }));
            ws.close(4003, "Protocol version mismatch");
            return;
          }
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          if (meta?.channel && meta.channel !== channelName) leaveChannel(ws, meta.channel);

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);
          emptyChannels.delete(channelName); // active again
          if (meta) {
            meta.channel = channelName;
            meta.requesterId = data.requesterId || data.message?.params?.requesterId || meta.requesterId;
            // Infer role from the join message shape so it's known immediately
            // (before any command/response traffic):
            //   - MCP server / console tester join with message.command === "join"
            //   - the Figma plugin sends a bare { type:"join", channel }
            if (meta.role === "unknown" || meta.role === "monitor") {
              meta.role = data.message?.command === "join" ? "controller" : "figma";
            }
          }

          console.log(`\n✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

          pushEvent({
            kind: "join",
            clientId: meta?.id,
            channel: channelName,
            clientCount: channelClients.size,
          });
          pushChannels();

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          if (data.message?.command) {
            if (meta) {
              meta.role = "controller";
              meta.lastCommand = data.message.command;
            }
            const requestId = data.message.id || data.id;
            const figma = chooseFigma(channelName);
            if (!figma) {
              ws.send(JSON.stringify({
                type: "broadcast",
                channel: channelName,
                message: { id: requestId, error: "No healthy Figma plugin is available for this project", result: {} },
              }));
              return;
            }
            const figmaMeta = clientMeta.get(figma)!;
            const queuedAt = Date.now();
            const request: RequestMeta = {
              id: requestId,
              channel: channelName,
              command: data.message.command,
              requester: ws,
              requesterId: meta?.requesterId ?? meta?.id ?? "unknown",
              figma,
              queuedAt,
              dispatchedAt: queuedAt,
              batchId: data.message.params?.batchId,
            };
            requests.set(requestId, request);
            figmaMeta.activeRequests++;
            pushEvent({
              kind: "command",
              clientId: meta?.id,
              requesterId: request.requesterId,
              figmaClientId: figmaMeta.id,
              channel: channelName,
              commandId: requestId,
              command: data.message.command,
              params: truncate(data.message.params),
              batchId: request.batchId,
              queueDepth: figmaMeta.activeRequests,
            });
            figma.send(JSON.stringify({
              type: "broadcast",
              message: data.message,
              sender: request.requesterId,
              channel: channelName,
            }));
            pushChannels();
            return;
          } else if (
            data.message?.result !== undefined ||
            data.message?.error !== undefined
          ) {
            if (meta) meta.role = "figma";
            const isError = data.message.error !== undefined && data.message.error !== null;
            const requestId = data.message.id || data.id;
            const request = requests.get(requestId);
            if (!request || request.figma !== ws) return;
            const completedAt = Date.now();
            const startedAt = request.startedAt ?? request.dispatchedAt ?? request.queuedAt;
            const timing = {
              waitMs: startedAt - request.queuedAt,
              executionMs: completedAt - startedAt,
              totalMs: completedAt - request.queuedAt,
            };
            if (meta) meta.activeRequests = Math.max(0, meta.activeRequests - 1);
            recordFigmaOutcome(ws, false);
            pushEvent({
              kind: "result",
              clientId: meta?.id,
              requesterId: request.requesterId,
              channel: channelName,
              commandId: requestId,
              command: request.command,
              ok: !isError,
              result: truncate(data.message.result),
              error: data.message.error,
              timing,
              batchId: request.batchId,
            });
            if (request.onInternalResult) {
              request.onInternalResult(data.message);
            } else if (request.requester && request.requester.readyState === WebSocket.OPEN) {
              request.requester.send(JSON.stringify({
                type: "broadcast",
                message: { ...data.message, timing },
                sender: meta?.id ?? "figma",
                channel: channelName,
              }));
            }
            requests.delete(requestId);
            pushChannels();
            return;
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          pushEvent({
            kind: "progress",
            clientId: meta?.id,
            channel: channelName,
            commandId: data.id,
            progress: data.message?.data?.progress,
            status: data.message?.data?.status,
            message: data.message?.data?.message,
            commandType: data.message?.data?.commandType,
          });

          const request = requests.get(data.id);
          if (request && request.figma === ws && request.requester && request.requester.readyState === WebSocket.OPEN) {
            request.requester.send(JSON.stringify(data));
          }
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<any>) {
      const meta = clientMeta.get(ws);

      monitors.delete(ws);

      for (const [id, request] of requests) {
        if (request.requester === ws) {
          const figmaMeta = request.figma ? clientMeta.get(request.figma) : undefined;
          if (figmaMeta) figmaMeta.activeRequests = Math.max(0, figmaMeta.activeRequests - 1);
          requests.delete(id);
        } else if (request.figma === ws) {
          if (request.onInternalResult) {
            request.onInternalResult({ id, error: "Figma plugin disconnected while executing the request" });
          } else if (request.requester && request.requester.readyState === WebSocket.OPEN) {
            request.requester.send(JSON.stringify({
              type: "broadcast",
              channel: request.channel,
              message: { id, error: "Figma plugin disconnected while executing the request", result: {} },
            }));
          }
          requests.delete(id);
        }
      }

      // Remove client from their channel(s) and notify peers
      channels.forEach((clients, channelName) => {
        if (clients.has(ws)) {
          clients.delete(ws);

          clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A user has left the channel",
                channel: channelName
              }));
            }
          });

          // When the Figma plugin leaves, the channel can no longer do anything
          // useful (no one to execute commands), so evict the remaining
          // clients from it. Skip if another Figma client is still present.
          if (meta && meta.role === "figma" && clients.size > 0) {
            let figmaRemains = false;
            clients.forEach((c) => {
              const cm = clientMeta.get(c);
              if (cm && cm.role === "figma") figmaRemains = true;
            });
            if (!figmaRemains) {
              const evictedCount = clients.size;
              clients.forEach((c) => {
                if (c.readyState === WebSocket.OPEN) {
                  c.send(JSON.stringify({
                    type: "system",
                    event: "channel_closed",
                    message: "Figma left the channel; channel closed.",
                    channel: channelName,
                  }));
                }
                const cm = clientMeta.get(c);
                if (cm) cm.channel = null;
              });
              clients.clear();
              console.log(`\n🚪 Figma left "${channelName}" → evicted ${evictedCount} remaining client(s)`);
              pushEvent({ kind: "channel_closed", channel: channelName, reason: "figma_left", evicted: evictedCount });
            }
          }

          // Keep the (now empty) channel around so its history stays visible
          // in the console, but mark it empty and prune old ones.
          if (clients.size === 0) {
            emptyChannels.set(channelName, Date.now());
            pruneEmptyChannels();
          }
        }
      });

      console.log(`Client disconnected (${meta?.id})`);

      if (meta) {
        pushEvent({ kind: "disconnect", clientId: meta.id, channel: meta.channel });
      }
      clientMeta.delete(ws);
      pushChannels();
    }
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [client, meta] of clientMeta) {
    if (meta.role === "monitor") continue;
    if (now - meta.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      pushEvent({ kind: "heartbeat_timeout", clientId: meta.id, requesterId: meta.requesterId, channel: meta.channel });
      client.close(4001, "Heartbeat timeout");
      continue;
    }
    try {
      client.ping(String(now));
    } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);

console.log(`WebSocket server running on port ${server.port}`);
console.log(`Web console available at http://localhost:${server.port}/console`);
