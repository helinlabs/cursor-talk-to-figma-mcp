// ---------------------------------------------------------------------------
// Figma health watch.
//
// The plugin dies quietly: the window stays open, the relay keeps the channel,
// and nothing tells anyone until a developer's request fails. This watches for
// that and reports to Slack, at two depths because the two failures are not the
// same shape:
//
//   shallow — is a plugin connected for every project that should have one?
//             Two localhost GETs against the relay — cheap enough to run every
//             minute, so a drop surfaces on its own rather than as a developer's
//             failed request.
//
//   deep    — can the plugin actually answer? A connected-but-wedged plugin
//             looks perfectly healthy to the shallow check. This one asks it to
//             enumerate pages and fetch a node, which is what a real caller does.
//             It costs a plugin round-trip, so it runs rarely and one project at
//             a time.
//
// Deep checks are deliberately READ-ONLY. Feature work drives these same Figma
// windows all day, and a monitor that changed the active page would be a worse
// problem than the one it reports.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../shared/version";

const RELAY_HTTP = process.env.HEALTH_RELAY_HTTP || "http://127.0.0.1:3055";
const RELAY_WS = process.env.HEALTH_RELAY_WS || "ws://127.0.0.1:3055";
// Prefer a 0600 file over an env var. A launchd plist is world-readable and
// gets dumped by any routine diagnostic — the recon that went looking for this
// very token read every plist's environment on the box.
const TOKEN_PATH = process.env.HEALTH_SLACK_TOKEN_PATH
  || `${homedir()}/.talk-to-figma/slack-bot-token`;
function readToken(): string {
  if (process.env.HEALTH_SLACK_TOKEN) return process.env.HEALTH_SLACK_TOKEN.trim();
  try {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return "";
  }
}
const SLACK_TOKEN = readToken();
const SLACK_CHANNEL = process.env.HEALTH_SLACK_CHANNEL || "C0BUHAXP22F";   // #dev_noti_figma
// Who to pull in when something is broken. Slack member id, not a display name.
const ALERT_USER = process.env.HEALTH_ALERT_USER || "U0A91CC94TZ";   // Garen
const PORT = Number(process.env.HEALTH_PORT || 3057);
// Somewhere to go from the message. On an alert this is the difference between
// "something is wrong" and being one click from looking at it.
const CONSOLE_URL = process.env.HEALTH_CONSOLE_URL
  || "https://nexus.helinlabs.com/tunnel/svc/macmini-1/figma-relay/";
const consoleLink = `<${CONSOLE_URL}|웹 릴레이 콘솔 열기>`;

// Which build is talking. This gets redeployed often, and without it the only
// way to tell whether a fix is actually live is to go and look at the box —
// which is exactly the trip the card exists to save.
const STARTED_AT = Date.now();
const BUILD = (() => {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: new URL("../..", import.meta.url).pathname,
    });
    const sha = new TextDecoder().decode(result.stdout).trim();
    return sha || "unknown";
  } catch {
    return "unknown";
  }
})();

const SHALLOW_MS = Number(process.env.HEALTH_SHALLOW_MS || 60_000);
// One project per turn, so the interval that matters is this times the number
// of managed projects: at 5 minutes and six projects each file is exercised
// about every half hour, which is close enough to catch a wedged plugin before
// someone runs into it without turning the probe into steady load.
const DEEP_MS = Number(process.env.HEALTH_DEEP_MS || 5 * 60_000);
// After a deep failure the picture is stale in the direction that matters, so
// re-ask sooner than the normal cadence.
const DEEP_RETRY_MS = Number(process.env.HEALTH_DEEP_RETRY_MS || 2 * 60_000);
// These are large design files; a first call into one can legitimately take a
// while, and calling that a failure would be its own false alarm.
const DEEP_COMMAND_MS = Number(process.env.HEALTH_DEEP_COMMAND_MS || 45_000);
// A shallow check is cheap enough to run every few seconds, but Slack is not:
// the rolling "all clear" message is rewritten on its own slower clock, and the
// check count on it is what shows the real cadence.
const HEALTHY_UPDATE_MS = Number(process.env.HEALTH_HEALTHY_UPDATE_MS || 5 * 60_000);
const DEGRADED_UPDATE_MS = Number(process.env.HEALTH_DEGRADED_UPDATE_MS || 60_000);
// One bad poll is usually a plugin reconnecting, not an outage — the plugin's
// own retry loop is 15s, so anything self-healing is back well inside a single
// minute-long poll. Two in a row means it did not come back on its own.
const FAIL_STREAK = Number(process.env.HEALTH_FAIL_STREAK || 2);

const STATE_PATH = process.env.HEALTH_STATE_PATH
  || `${homedir()}/.talk-to-figma/health-state.json`;
const PROJECTS_JSON = process.env.HEALTH_PROJECTS_JSON
  || `${homedir()}/.codex/skills/figma-product-mcp/scripts/projects.json`;

type Health = {
  // Projects whose last deep verdict was a failure, regardless of which one
  // this tick probed. Drives the headline so it cannot disagree with the list.
  failingDeep?: string[];
  ok: boolean;
  relayUp: boolean;
  expected: string[];
  live: string[];
  missing: string[];
  load: Array<{ name: string; running: number; pending: number; oldestQueuedMs: number }>;
  shallowMs: number;
  deep: { project: string; ok: boolean; detail: string; ms?: number } | null;
};

type State = {
  status: "healthy" | "degraded" | "unknown";
  messageTs: string | null;      // the rolling message we keep rewriting
  checks: number;                // checks folded into the current message
  since: number;                 // when the current status began
  lastPostedAt: number;
  streak: Record<string, number>;
  // When each project was last confirmed missing. The incident has one start
  // time, but the projects inside it do not: a second one failing hours later
  // was being shown under the first one's clock, which read as though
  // everything had been down all along.
  downSince: Record<string, number>;
  deepCursor: number;
  deepPoolSize: number;
  // Recent timings, newest last, kept separately because the two probes sample
  // at very different rates. A probe that is merely getting slower is the
  // interesting signal — it shows up here long before anything fails outright.
  slowActive: boolean;           // an outlier has been reported and not yet cleared
  // The alert card for the incident in progress. Changes hang off this rather
  // than off whatever card happens to be current, so the whole sequence — including
  // the recoveries that end it — stays in one thread instead of splitting across
  // the alert and the all-clear that replaces it.
  incidentTs: string | null;
  speedTs: string | null;        // the speed record living in the card's thread
  speedParentTs: string | null;
  speedPostedAt: number;
  shallowHistory: number[];
  deepHistory: Array<{ at: number; project: string; ok: boolean; ms: number }>;
  // The last deep verdict for EACH project, which deepHistory cannot answer:
  // it is a rolling window sized for the speed trend, so the oldest project's
  // result falls out of it, and it does not carry the detail that says why a
  // project failed. Without this the card could only ever show a verdict for
  // the one project this turn happened to probe, and every other project read
  // as "유휴" — including ones whose last probe had failed.
  deepResults: Record<string, { at: number; ok: boolean; ms: number; detail: string }>;
  // Slowness is judged against each project's OWN recent timings.
  //
  // One shared baseline made a heavy file permanently "slow": CA_Product runs
  // 10-17s where the other six run 0.2-0.8s, so against their mixed average
  // it was a 3-7x outlier on every probe. And one shared slowActive flag was
  // re-armed by the very next probe — which is a different, fast project — so
  // the alert fired again every rotation: a new @mention in #dev_noti_figma
  // every ~38 minutes all day on 2026-09-15.
  deepDurations: Record<string, number[]>;
  slowSince: Record<string, number>;     // an episode in progress, per project
  slowAlertedAt: Record<string, number>; // last alert per project, for the cooldown
};

function loadState(): State {
  try {
    const loaded = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return {
      ...blankState(), ...loaded,
      shallowHistory: Array.isArray(loaded.shallowHistory)
        ? loaded.shallowHistory.filter(usableMs)
        : [],
      // Scrub on load. The bad samples are already on disk, and history
      // outlives a deploy — without this the fix would not show up on the card
      // until twenty more checks had pushed them out of the window.
      deepHistory: Array.isArray(loaded.deepHistory)
        ? loaded.deepHistory.filter((entry: { ok?: boolean; ms?: number }) => !entry?.ok || usableMs(entry?.ms))
        : [],
      deepResults: loaded.deepResults && typeof loaded.deepResults === "object" ? loaded.deepResults : {},
      // Backfill from deepHistory the first time, so per-project judging starts
      // with the history already on disk instead of hours of silence.
      deepDurations: loaded.deepDurations && typeof loaded.deepDurations === "object"
        ? loaded.deepDurations
        : durationsFromHistory(Array.isArray(loaded.deepHistory) ? loaded.deepHistory : []),
      slowSince: loaded.slowSince && typeof loaded.slowSince === "object" ? loaded.slowSince : {},
      slowAlertedAt: loaded.slowAlertedAt && typeof loaded.slowAlertedAt === "object" ? loaded.slowAlertedAt : {},
    };
  } catch {
    return blankState();
  }
}
function durationsFromHistory(history: Array<{ project?: string; ok?: boolean; ms?: number }>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const entry of history) {
    if (!entry?.ok || !entry.project || !usableMs(entry.ms)) continue;
    const key = nameKey(entry.project);
    (out[key] ||= []).push(entry.ms as number);
    if (out[key].length > SPEED_WINDOW) out[key].shift();
  }
  return out;
}
function blankState(): State {
  return { status: "unknown", messageTs: null, checks: 0, since: Date.now(), lastPostedAt: 0, slowActive: false, incidentTs: null, speedTs: null, speedParentTs: null, speedPostedAt: 0, streak: {}, downSince: {}, deepCursor: 0, deepPoolSize: 1, shallowHistory: [], deepHistory: [], deepResults: {}, deepDurations: {}, slowSince: {}, slowAlertedAt: {} };
}
function saveState(state: State): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("[health] could not persist state:", error);
  }
}

// --- what SHOULD be up -----------------------------------------------------
// The launcher's config is the only place that says which files this machine is
// supposed to keep connected. Without it we would have to treat "no plugin" and
// "nobody ever wanted one" as the same thing.
// Re-read periodically rather than once: the launcher config is edited when a
// project is added, and a monitor that needs restarting to notice would be a
// quiet way to stop watching something.
let expectedCache: { at: number; value: string[] } | null = null;
function expectedProjects(): string[] {
  if (expectedCache && Date.now() - expectedCache.at < 60_000) return expectedCache.value;
  const value = readExpectedProjects();
  expectedCache = { at: Date.now(), value };
  return value;
}

function readExpectedProjects(): string[] {
  try {
    const config = JSON.parse(readFileSync(PROJECTS_JSON, "utf8"));
    const wanted = new Set<string>(config.defaultProjectIDs || []);
    return (config.projects || [])
      .filter((project: any) => wanted.has(project.id))
      .map((project: any) => String(project.title || project.id));
  } catch {
    return [];
  }
}

// The two sides spell the same project differently: the launcher config calls
// it "CA_Product" while the relay reports the document's real name, which
// carries the emoji the file is actually named with ("🔴 CA_Product"). Comparing
// them literally marked every project missing — and the only reason the first
// deployment did not page anyone for it was the failure-streak damping, which
// would have run out on the next poll. Match on the letters, ignoring the emoji
// and punctuation the names differ by.
const nameKey = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

// The relay reports the document's real name, which is prefixed with the emoji
// the Figma file is named with — and those collide with the status emoji this
// card uses (a project called "🔴 CA_Product" reads as a red alert sitting
// inside a green all-clear). The launcher config already carries a clean title
// per project, so display that and fall back to stripping the prefix.
function displayName(name: string): string {
  const key = nameKey(name);
  for (const title of expectedProjects()) {
    const candidate = nameKey(title);
    if (candidate === key || key.includes(candidate) || candidate.includes(key)) return title;
  }
  return name.replace(/^[^\p{L}\p{N}]+/u, "").trim() || name;
}

function isPresent(expected: string, live: string[]): boolean {
  const key = nameKey(expected);
  return key.length > 0 && live.some((name) => {
    const candidate = nameKey(name);
    return candidate === key || candidate.includes(key) || key.includes(candidate);
  });
}

async function getJson(path: string, timeoutMs = 5000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${RELAY_HTTP}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function shallowCheck(): Promise<Health> {
  const started = Date.now();
  const expected = expectedProjects();
  let load: Health["load"] = [];
  try {
    await getJson("/health");
  } catch (error) {
    return { ok: false, relayUp: false, expected, live: [], missing: expected, load, shallowMs: Date.now() - started, deep: null };
  }
  let live: string[] = [];
  try {
    const payload = await getJson("/projects");
    const liveProjects = (payload.projects || []).filter((project: any) => project.connectionCount > 0);
    live = liveProjects.map((project: any) => String(project.name));
    load = liveProjects.map((project: any) => ({
      name: String(project.name),
      running: project.runningRequests || 0,
      pending: project.pendingRequests || 0,
      oldestQueuedMs: project.oldestQueuedMs || 0,
    }));
  } catch {
    return { ok: false, relayUp: true, expected, live: [], missing: expected, load, shallowMs: Date.now() - started, deep: null };
  }
  const missing = expected.filter((name) => !isPresent(name, live));
  return { ok: missing.length === 0, relayUp: true, expected, live, missing, load, shallowMs: Date.now() - started, deep: null };
}

// --- deep check ------------------------------------------------------------
// Speaks the relay's controller protocol directly: hello -> join -> command.
// One command per connection keeps this simple and means a wedged plugin can
// never leave a socket parked.
function runCommand(channel: string, command: string, params: any, timeoutMs = 20_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(RELAY_WS);
    const rid = () => Math.random().toString(36).slice(2);
    let joined = false;
    let requestId: string | null = null;
    const done = (error: Error | null, value?: any) => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => done(new Error(`no response in ${timeoutMs}ms`)), timeoutMs);
    socket.on("error", (error) => done(error instanceof Error ? error : new Error(String(error))));
    socket.on("open", () => socket.send(JSON.stringify({
      type: "hello", role: "controller", requesterId: `health-${rid()}`, protocolVersion: PROTOCOL_VERSION,
    })));
    socket.on("message", (raw: any) => {
      let data: any;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.type === "system" && data.event === "protocol_mismatch") {
        return done(new Error(`protocol mismatch: ${data.message}`));
      }
      if (data.type === "system" && data.event === "hello_ack") {
        const id = rid();
        socket.send(JSON.stringify({ id, type: "join", channel, message: { id, command: "join", params: { channel } } }));
        return;
      }
      // The relay greets with a plain-string system frame before the join
      // result; only an object carrying `result` means we are actually joined.
      if (!joined && data.type === "system" && data.message && typeof data.message === "object" && "result" in data.message) {
        joined = true;
        requestId = rid();
        socket.send(JSON.stringify({
          id: requestId, type: "message", channel,
          message: { id: requestId, command, params: { ...params, commandId: requestId } },
        }));
        return;
      }
      if (data.type === "progress_update") return;
      const message = data.message;
      if (message && message.id === requestId) {
        if (message.error) return done(new Error(String(message.error)));
        return done(null, message.result);
      }
    });
  });
}

// The plugin has returned image payloads under a few shapes over time; measure
// whatever it gives rather than asserting one.
// A sub-kilobyte export rounded to "0KB", which reads like a failure rather
// than a very small image.
const sizeOf = (bytes: number) => (bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`);

function imageBytes(result: any): number {
  if (!result) return 0;
  const data = result.imageData ?? result.data ?? result.svg ?? result.bytes;
  if (typeof data === "string") return data.length;
  if (data && typeof data.length === "number") return data.length;
  return 0;
}

// Gap between the two measurements, long enough that a momentary stall is not
// simply repeated and short enough that both describe the same conditions.
const DEEP_RETRY_PAUSE_MS = Number(process.env.HEALTH_DEEP_RETRY_PAUSE_MS || 3_000);

async function deepCheck(state: State): Promise<Health["deep"]> {
  const first = await deepProbe(state);
  if (!first) return null;

  // Measure twice, always. One sample cannot tell a slow moment from a slow
  // plugin: F_Product timed out at 45s and answered in under three seconds on
  // the very next call, which had already paged someone for nothing. Keeping
  // both is better than keeping one — the first carries whatever cold cost a
  // real caller would hit, the second shows the warm floor — and the trend uses
  // the lower of the two so a single hiccup cannot drag the baseline around.
  await new Promise((resolve) => setTimeout(resolve, DEEP_RETRY_PAUSE_MS));
  state.deepCursor = (state.deepCursor + state.deepPoolSize - 1) % Math.max(1, state.deepPoolSize);
  const second = await deepProbe(state);
  if (!second) return first;

  const ok = first.ok || second.ok;
  const passes = [first, second].filter((attempt) => attempt.ok);
  // Take the lower of the two, but only among attempts that actually carry a
  // timing. The old form substituted MAX_SAFE_INTEGER for a missing ms so that
  // Math.min would ignore it — except when *every* pass was missing one, and
  // then the sentinel came back out as the measurement. It went into the
  // history and the twenty-sample average, which is how the card came to claim
  // a 9007199254741s deep check. A missing number has to stay missing.
  const timings = passes
    .map((attempt) => attempt.ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const measured = timings.length ? Math.min(...timings) : undefined;

  let detail: string;
  if (first.ok && second.ok) {
    detail = `${second.detail} · 1차 ${secs(first.ms ?? 0)} / 2차 ${secs(second.ms ?? 0)}`;
  } else if (ok) {
    const good = first.ok ? first : second;
    const bad = first.ok ? second : first;
    detail = `2회 중 1회만 정상 — ${good.detail} · 실패한 쪽: ${bad.detail}`;
  } else {
    detail = `2회 연속 실패 — 1차: ${first.detail} · 2차: ${second.detail}`;
  }
  return { project: second.project, ok, detail, ms: measured };
}

async function deepProbe(state: State): Promise<Health["deep"]> {
  let projects: any[] = [];
  try {
    projects = ((await getJson("/projects")).projects || [])
      .filter((project: any) => project.connectionCount > 0 && project.recommendedChannel);
  } catch {
    return null;
  }
  // Only probe what the launcher promises to keep alive. F_Product is connected
  // but is not in defaultProjectIDs, and paging someone because an unmanaged
  // file is slow teaches them to ignore the channel.
  const managed = projects.filter((project: any) => isPresent(String(project.name), expectedProjects())
    || expectedProjects().some((title) => isPresent(title, [String(project.name)])));
  const pool = managed.length ? managed : [];
  if (!pool.length) return null;
  const projects_ = pool;
  // A failing project gets re-probed on alternate turns.
  //
  // The cursor rotates blindly, so a failure had to wait for six healthy
  // projects before anything could clear it — a project stayed reported broken
  // for up to a full rotation after it had already recovered. Failures are what
  // the rotation exists to find, so they deserve to be looked at sooner.
  //
  // But not every turn: always preferring the failure pins the rotation to it,
  // and the other six are never re-probed at all — they would go stale, which
  // is a worse blindness than the slow recovery this fixes.
  //
  // The bound is TIME SINCE that project was last probed, not a turn counter.
  // Parity of deepCursor looked equivalent and was not: deepCheck probes twice
  // and rewinds the cursor between the two, so the parity a probe sees is not
  // the parity of the turn. Measured, that gave the failing project 8 of 12
  // consecutive probes — very nearly the pinning this was written to avoid.
  // Elapsed time cannot be knocked out of step by how many probes a turn runs.
  const failing = projects_.find((candidate: any) =>
    state.deepResults[nameKey(String(candidate.name))]?.ok === false);
  const failingLast = failing
    ? state.deepResults[nameKey(String(failing.name))]?.at ?? 0
    : 0;
  const project = (failing && Date.now() - failingLast >= DEEP_MS)
    ? failing
    : projects_[state.deepCursor % projects_.length];
  state.deepPoolSize = projects_.length;
  state.deepCursor = (state.deepCursor + 1) % Math.max(1, projects_.length);
  const name = String(project.name);
  const channel = project.recommendedChannel;
  const probeStarted = Date.now();
  // What the plugin was already doing when this probe arrived. Reported first
  // because it is the context for everything that follows: the plugin runs one
  // command at a time, so a probe behind real work is slow for a reason that is
  // not a fault.
  const queuedBefore = (project.runningRequests || 0) + (project.pendingRequests || 0);
  const waitBefore = project.oldestQueuedMs || 0;
  const loadNote = queuedBefore
    ? `선행 작업 ${queuedBefore}건(최장 ${secs(waitBefore)}) 뒤에서 측정`
    : "유휴 상태에서 측정";
  const timings: string[] = [];
  const timed = async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const value = await run();
    timings.push(`${label} ${Date.now() - started}ms`);
    return value;
  };
  let restorePageId: string | null = null;
  try {
    // withChildCounts defaults true, which makes the plugin call
    // loadAllPagesAsync() and load every page in the document — that was most
    // of the 22s this probe used to take, not the image payload. The cheap form
    // still returns the page list and which one is current, which is all this
    // needs.
    const pages: any = await timed("pages", () =>
      runCommand(channel, "list_pages", { withChildCounts: false }, DEEP_COMMAND_MS));
    const list: any[] = Array.isArray(pages) ? pages : (pages?.pages || []);
    if (!list.length) {
      return { project: name, ok: false, ms: Date.now() - probeStarted,
        detail: "plugin answered but reported no pages" };
    }
    const currentId: string | null = pages?.currentPageId ?? null;

    // Page selection, for real — but put the document back where it was. These
    // files are being worked in, so leaving one on a different page would be a
    // worse bug than the one this probe is looking for.
    const other = list.find((page: any) => page?.id && page.id !== currentId) ?? null;
    if (currentId && other) {
      restorePageId = currentId;
      await timed("select", () => runCommand(channel, "set_current_page", { pageId: other.id }, DEEP_COMMAND_MS));
      await timed("restore", () => runCommand(channel, "set_current_page", { pageId: currentId }, DEEP_COMMAND_MS));
      restorePageId = null;
    }

    // Reading the page back: get_document_info loads only the current page,
    // where get_node_info on a page serialises its whole subtree.
    const info: any = await timed("read", () => runCommand(channel, "get_document_info", {}, DEEP_COMMAND_MS));
    const childrenOf = (payload: any): any[] => payload?.children || payload?.node?.children || [];

    // Finding something exportable means moving between pages, not just
    // looking further down one.
    //
    // GW_Product's current page is empty, so the probe fell through to the
    // 레퍼런스 page — where all 45 top-level nodes refuse to export. Trying
    // more of them cannot help: measured 2026-09-09, the first sixteen all
    // failed. The page itself is the wrong place to look, so when a page
    // gives up nothing the probe now moves to the next one.
    //
    // The per-page cap stays small because a refusal is NOT uniformly cheap.
    // On that page the first eight refused in 90-136ms and the next eight took
    // 2.8s to 14s, so a generous count is a slow probe waiting to happen. The
    // shared budget below is what actually bounds this; the count only keeps
    // any single page from eating it.
    const EXPORT_PER_PAGE = 5;
    const EXPORT_PAGES = 4;
    const PAGE_OPEN_MS = Number(process.env.HEALTH_PAGE_OPEN_MS || 4_000);
    const EXPORT_BUDGET_MS = DEEP_COMMAND_MS * 2;
    const exportDeadline = Date.now() + EXPORT_BUDGET_MS;
    const unexportable = (text: string) =>
      /failed to export node|visible layers/i.test(text);

    // The reason is known where the failure happens. Recovering it later by
    // running the regex over "name: message" let a node named after what it
    // contains ("visible layers audit") turn a real failure into a pass.
    const refusals: { text: string; refused: boolean }[] = [];
    let bytes: any = null;
    let usedTarget: any = null;
    let usedPage: string | null = null;
    let tried = 0;
    let seen = 0;
    let pagesLooked = 0;
    let ranOutOfTime = false;

    const tryPage = async (label: string, payload: any): Promise<boolean> => {
      const candidates = childrenOf(payload).filter((child: any) => child?.id);
      if (!candidates.length) return false;
      pagesLooked++;
      seen += candidates.length;
      for (const candidate of candidates.slice(0, EXPORT_PER_PAGE)) {
        const left = exportDeadline - Date.now();
        if (left <= 0) { ranOutOfTime = true; return false; }
        tried++;
        const nodeLabel = candidate.name || candidate.id;
        const attemptStarted = Date.now();
        let image: any;
        try {
          image = await timed("image", () => runCommand(channel, "export_node_as_image",
            { nodeId: candidate.id, format: "PNG", scale: 0.05 }, Math.min(DEEP_COMMAND_MS, left)));
        } catch (error) {
          // timed() only records a step once it resolves, so a throw leaves the
          // seconds it burned out of the breakdown entirely — which is exactly
          // the case where the card has to explain a slow probe.
          timings.push(`image(실패) ${Date.now() - attemptStarted}ms`);
          const text = error instanceof Error ? error.message : String(error);
          if (!unexportable(text)) throw error;
          refusals.push({ text: `${label}/${nodeLabel}: ${text}`, refused: true });
          continue;
        }
        const got = imageBytes(image);
        if (got) { bytes = got; usedTarget = candidate; usedPage = label; return true; }
        refusals.push({ text: `${label}/${nodeLabel}: 응답에 이미지 없음`, refused: false });
      }
      return false;
    };

    // Opening another page is itself expensive, and failing to is not an outage.
    //
    // get_document_info with a pageId loads that page, and on a heavy one the
    // plugin does not answer inside Figma's own 10s window: it throws "Unable
    // to establish connection to Figma after 10 seconds." Letting that escape
    // turned a probe whose pages/select/restore/read had all just passed into
    // a hard failure — the plugin was plainly alive, one page was merely too
    // big to open on demand. A page that will not open is a page to skip.
    const unopened: string[] = [];
    let done = await tryPage(info?.name || "현재 페이지", info);
    if (!done && !ranOutOfTime) {
      for (const page of list.filter((entry: any) => entry?.id && entry.id !== currentId).slice(0, EXPORT_PAGES)) {
        if (ranOutOfTime || Date.now() >= exportDeadline) { ranOutOfTime = true; break; }
        const pageLabel = page.name || page.id;
        const readStarted = Date.now();
        let elsewhere: any;
        try {
          // Short leash on opening a page, because a slow open never pays off.
          //
          // Three of GW_Product's pages take Figma's full 10s window and then
          // refuse, so the probe spent 33.4s where every other project takes
          // 0.1-0.5s. Waiting the full DEEP_COMMAND_MS on them buys nothing:
          // a page that cannot be opened promptly is not a page to export
          // from, and the next one is likelier to work than this one is on a
          // second thought. childCount would let this pick small pages first,
          // but list_pages is deliberately called with withChildCounts:false
          // (that flag is what used to make this probe take 22s), so the
          // count is not available to sort by.
          elsewhere = await timed("read2", () =>
            runCommand(channel, "get_document_info", { pageId: page.id },
              Math.min(PAGE_OPEN_MS, Math.max(1, exportDeadline - Date.now()))));
        } catch (error) {
          timings.push(`read2(실패) ${Date.now() - readStarted}ms`);
          unopened.push(`${pageLabel}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        done = await tryPage(pageLabel, elsewhere);
        if (done) break;
      }
    }

    if (!seen) {
      return { project: name, ok: true, ms: Date.now() - probeStarted,
        detail: `${loadNote} · ${list.length} pages, selection ok, 내용 있는 페이지 없음`
          + `${unopened.length ? ` (열리지 않은 페이지 ${unopened.length}개: ${unopened.join(" · ")})` : ""}`
          + ` · ${timings.join(" · ")}` };
    }
    const skippedPages = unopened.length ? `, 열리지 않은 페이지 ${unopened.length}개` : "";
    const scope = `${pagesLooked}개 페이지에서 ${tried}/${seen}개 시도${skippedPages}`;
    if (!bytes) {
      const allRefused = !ranOutOfTime && refusals.length > 0
        && refusals.every((entry) => entry.refused);
      if (allRefused) {
        return { project: name, ok: true, ms: Date.now() - probeStarted,
          detail: `${loadNote} · ${list.length} pages, selection ok, node read, `
            + `이미지 내보내기 대상 없음(보이는 레이어 없는 노드, ${scope}) · ${timings.join(" · ")}` };
      }
      const why = ranOutOfTime ? `${scope}, 시간 초과` : scope;
      return { project: name, ok: false, ms: Date.now() - probeStarted,
        detail: `image export returned nothing (${why}) — `
          + `${refusals.map((entry) => entry.text).join(" · ") || "후보 없음"} · ${timings.join(" · ")}` };
    }
    const skipped = refusals.length ? `, ${refusals.length}개 건너뜀` : "";
    return { project: name, ok: true, ms: Date.now() - probeStarted,
      detail: `${loadNote} · ${list.length} pages, selection ok, node read, `
        + `image ${sizeOf(bytes)}${skipped} (${usedPage}/${usedTarget.name || usedTarget.id}) · ${timings.join(" · ")}` };
  } catch (error) {
    // A probe that fails after switching pages must not leave the document
    // parked somewhere the person working in it did not put it.
    if (restorePageId) {
      try { await runCommand(channel, "set_current_page", { pageId: restorePageId }, DEEP_COMMAND_MS); } catch {}
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { project: name, ok: false, ms: Date.now() - probeStarted,
      detail: timings.length ? `${detail} · ${timings.join(" · ")}` : detail };
  }
}

// --- Slack -----------------------------------------------------------------
// Every network call in the loop has a deadline, and this was the one that did
// not. getJson aborts after 5s and runCommand after its timeout, but slack()
// awaited a bare fetch. On 2026-09-12 a Slack post stalled and never settled:
// report() never returned, so tick() never cleared `ticking`, and every tick
// after that returned immediately without checking anything. The process stayed
// up, the port kept answering, the tunnel showed it listening — and it said
// nothing for 51 hours. A post that cannot finish in time is now a failed post,
// which report() already handles; the next tick retries.
const SLACK_TIMEOUT_MS = Number(process.env.HEALTH_SLACK_TIMEOUT_MS || 15_000);

// Only a definitive answer from Slack means the message is gone for good.
//
// A timed-out chat.update may well have landed. Treating it like
// "message_not_found" posted a brand-new card on every round of a slow Slack,
// which under a sustained slowdown is a new message in #dev_noti_figma every
// five minutes — trading a silent watcher for a noisy one. On a transient
// failure keep the ts and try the edit again next round.
const replaceable = (result: any) => !result?.ok && !result?.transient;

async function slack(method: string, body: any): Promise<any> {
  if (!SLACK_TOKEN || !SLACK_CHANNEL) return { ok: false, error: "slack not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel: SLACK_CHANNEL, ...body }),
      signal: controller.signal,
    });
    const payload = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
    if (!payload.ok) console.error(`[health] slack ${method} failed:`, payload.error);
    return payload;
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${SLACK_TIMEOUT_MS}ms` : String(error);
    console.error(`[health] slack ${method} failed: ${reason}`);
    // Transient: we do not know whether Slack applied it. That is different
    // from Slack answering "message_not_found", and callers must not treat the
    // two the same way — see replaceable() below.
    return { ok: false, error: reason, transient: true };
  } finally {
    clearTimeout(timer);
  }
}

const clock = (at = Date.now()) => new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
function humanSince(from: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - from) / 60_000));
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

// "7/6" reads like a fault. The extra is F_Product, which is connected but not
// in the launcher's default set, so count coverage against what is required and
// mention anything beyond it separately.
function coverage(health: Health): string {
  const covered = health.expected.length - health.missing.length;
  const extra = Math.max(0, health.live.length - covered);
  return `필수 ${covered}/${health.expected.length}` + (extra ? ` · 그 외 ${extra}` : "");
}


// --- speed trend -----------------------------------------------------------
// One number says nothing. Averaging a recent window and comparing it against
// the window before it turns the same samples into "is this getting worse",
// which is the question worth putting on the card.
const SPEED_WINDOW = Number(process.env.HEALTH_SPEED_WINDOW || 20);

// The rule for what counts as a measurement, kept in one evaluable block so the
// test asserts on the same source the watcher runs (same trick as the console's
// viewport-poll policy). Plain JS on purpose — no annotations to strip.
//
// >>> speed-sample-policy
// A duration we are willing to believe. Anything past this is not a slow
// plugin, it is a bug in our own bookkeeping — a deep check times out long
// before an hour, so an hour is a ceiling, not a tuning knob.
const MAX_PLAUSIBLE_MS = 60 * 60_000;

function usableMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PLAUSIBLE_MS;
}

// Averaging is where one bad sample does its damage: it survives twenty
// readings and drags the trend arrow with it. Only believable numbers count.
function mean(values) {
  const usable = values.filter(usableMs);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}
// <<< speed-sample-policy

function trend(series: number[]): { recent: number | null; delta: number | null } {
  const recent = mean(series.slice(-SPEED_WINDOW));
  const prior = mean(series.slice(-SPEED_WINDOW * 2, -SPEED_WINDOW));
  return { recent, delta: recent != null && prior != null ? recent - prior : null };
}

// Only call a change a change when it is big enough to mean something; a couple
// of milliseconds of noise dressed up with an arrow is worse than no arrow.
function withTrend(label: string, series: number[], format: (ms: number) => string): string | null {
  const { recent, delta } = trend(series);
  if (recent == null) return null;
  let suffix = "";
  if (delta != null && Math.abs(delta) >= Math.max(5, recent * 0.1)) {
    suffix = ` ${delta > 0 ? "▲" : "▼"}${format(Math.abs(delta))}`;
  }
  return `${label} ${format(recent)}${suffix}`;
}

const ms = (value: number) => `${Math.round(value)}ms`;
const secs = (value: number) => `${(value / 1000).toFixed(1)}s`;

// Speed belongs on a slower clock than status. Putting it in a thread under
// the status card keeps the channel readable — the card answers "is it up",
// the thread answers "is it getting slower" for anyone who opens it.
const SPEED_UPDATE_MS = Number(process.env.HEALTH_SPEED_UPDATE_MS || 30 * 60_000);

function speedText(state: State): string | null {
  const ok = state.deepHistory.filter((entry) => entry.ok);
  const parts = [
    withTrend("릴레이 응답", state.shallowHistory, ms),
    withTrend("심층 점검", ok.map((entry) => entry.ms), secs),
  ].filter(Boolean);
  if (!parts.length) return null;
  const lines = [
    `:stopwatch: *속도 기록* · 최근 ${SPEED_WINDOW}회 평균 (화살표는 그 이전 ${SPEED_WINDOW}회 대비)`,
    ...parts.map((part) => `• ${part}`),
  ];
  // One line per product. Six of these joined by "·" ran past the width of the
  // card and had to be read sideways; the question being asked here is "which
  // product is slow", and that is a column, not a sentence.
  const latest = new Map<string, { ok: boolean; ms: number }>();
  for (const entry of state.deepHistory.slice(-SPEED_WINDOW)) {
    latest.set(entry.project, { ok: entry.ok, ms: entry.ms });
  }
  if (latest.size) {
    lines.push("• 최근 심층");
    const rows = [...latest].map(([project, entry]) => ({ name: displayName(project), entry }));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const row of rows) {
      lines.push(`    ${row.name} — ${row.entry.ok ? secs(row.entry.ms) : "실패"}`);
    }
  }
  lines.push(`• 갱신: ${clock()}`);
  return lines.join("\n");
}


// --- traffic ---------------------------------------------------------------
// The relay now keeps per-project, per-command and per-caller aggregates. This
// pulls the useful slice into the same thread as the speed record, because the
// two answer the same kind of question — how is this holding up — and neither
// belongs in the status card.
const TRAFFIC_DAYS = Number(process.env.HEALTH_TRAFFIC_DAYS || 1);

async function trafficText(): Promise<string | null> {
  let stats: any;
  try {
    stats = await getJson(`/stats?days=${TRAFFIC_DAYS}&limit=6`, 8000);
  } catch {
    return null;   // an older relay without /stats simply omits this section
  }
  const slow: any[] = stats?.slowestCommands || [];
  const callers: any[] = stats?.requesters || [];
  if (!slow.length && !callers.length) return null;

  const lines = [`:bar_chart: *요청 통계* · 최근 ${TRAFFIC_DAYS}일`];
  if (slow.length) {
    lines.push("• 느린 명령 (평균 기준)");
    for (const row of slow.slice(0, 5)) {
      const failed = row.failed ? ` · 실패 ${row.failed}` : "";
      lines.push(`   ${displayName(row.project)} · \`${row.subject}\` — ${row.n}회 · 평균 ${secs(row.meanMs)} `
        + `· p95 ${row.p95} · 최대 ${secs(row.maxMs)}${failed}`);
    }
  }
  if (callers.length) {
    lines.push("• 요청자별");
    for (const row of callers.slice(0, 5)) {
      const failed = row.failed ? ` · 실패 ${row.failed}` : "";
      const wait = row.meanWaitMs > 200 ? ` · 평균 대기 ${secs(row.meanWaitMs)}` : "";
      lines.push(`   ${displayName(row.project)} · ${row.subject} — ${row.n}회 · 평균 ${secs(row.meanMs)}${wait}${failed}`);
    }
  }
  return lines.join("\n");
}

// The thread hangs off whichever status card is current, so a new card starts
// a new thread rather than stranding the record under an old one.
async function reportSpeed(state: State): Promise<void> {
  const parent = state.messageTs;
  if (!parent) return;
  const speed = speedText(state);
  const traffic = await trafficText();
  const text = [speed, traffic].filter(Boolean).join("\n\n");
  if (!text) return;
  if (state.speedParentTs !== parent) {
    state.speedParentTs = parent;
    state.speedTs = null;
  }
  const due = Date.now() - state.speedPostedAt >= SPEED_UPDATE_MS;
  if (state.speedTs && !due) return;
  if (state.speedTs) {
    const updated = await slack("chat.update", { ts: state.speedTs, text });
    if (replaceable(updated)) state.speedTs = null;
    else if (!updated?.ok) return;   // transient: leave the record, retry next round
  }
  if (!state.speedTs) {
    const posted = await slack("chat.postMessage", { text, thread_ts: parent });
    state.speedTs = posted?.ts ?? null;
  }
  state.speedPostedAt = Date.now();
}

// One line per project. The probe shares the plugin with real traffic — the
// plugin is single-threaded, so anything already running delays it — and a slow
// probe on a busy project is not the same finding as a slow probe on an idle
// one. Showing the load next to the timing is what separates them.
// Per-project verdict, one icon each.
//
// An alert used to name the one thing that broke and list every project's LOAD
// underneath, which is a different question: a project whose deep probe had
// just failed still read "유휴" because it was connected and not busy. So one
// broken project made the whole card look like a total outage, and a reader
// had no way to see that the other six were fine.
//
// The verdict now combines both things the watcher knows about a project: that
// it is connected (shallow, every 60s) and that it could actually answer
// commands (deep, one project per turn). The deep half is per-project and
// outlives the turn that produced it, so every line carries a real verdict
// rather than the verdict of whichever project was probed last.
type Verdict = { icon: string; label: string; broken: boolean; busy: boolean; stale?: boolean };

// How long a passing deep verdict is allowed to stand for.
//
// The rotation reaches each project about every DEEP_MS * projects, so a
// verdict older than a few of those rounds means the probe is no longer
// reaching that project at all — a drifting cursor, a rename that breaks the
// nameKey match, or deep checks being skipped because the shallow check keeps
// failing. Left unbounded, the last success stayed green forever: the card
// would assert a project was fine on evidence days old and count it toward
// "7/7 정상", which is precisely the claim this watcher exists to not make.
const DEEP_STALE_AFTER_MS = Number(process.env.HEALTH_DEEP_STALE_MS || 0) ||
  DEEP_MS * 7 * 3;

function verdictFor(title: string, health: Health, state?: State): Verdict {
  const byName = new Map(health.load.map((entry) => [nameKey(entry.name), entry]));
  const entry = [...byName.entries()]
    .find(([key]) => key.includes(nameKey(title)) || nameKey(title).includes(key))?.[1];

  if (!entry) {
    const downAt = state?.downSince?.[title];
    return {
      icon: ":red_circle:",
      label: "플러그인 없음" + (downAt ? ` · ${clock(downAt)}부터 (${humanSince(downAt)})` : ""),
      broken: true,
      busy: false,
    };
  }

  const busy = entry.running + entry.pending;
  // Busy is not broken. A queue means someone is using the file, and saying so
  // next to a green icon is the point — it explains a slow probe without
  // implying a fault.
  const load = busy
    ? `처리 ${entry.running} · 대기 ${entry.pending} · 최장 ${secs(entry.oldestQueuedMs)}`
    : "유휴";

  const deep = state?.deepResults?.[nameKey(title)];
  // Waiting for a turn is not the same as being unknown.
  //
  // A white circle reads as "empty" — right after a restart the card was six
  // white and one red, which looks like nothing is working. But the shallow
  // check confirms every one of these is connected, every 60s; only the deep
  // rotation has not reached them yet. Blue says "no problem found, its turn
  // has not come", which is what is actually true.
  if (!deep) {
    return { icon: ":large_blue_circle:", label: `${load} · 심층 점검 대기`, broken: false, busy: busy > 0 };
  }
  const age = humanSince(deep.at);
  // A failure is reported however old it is: nothing has come along to say it
  // was fixed, and going quiet about it would be worse than showing its age.
  if (!deep.ok) {
    return { icon: ":red_circle:", label: `${load} · 심층 실패 (${age} 전) — ${deep.detail}`, broken: true, busy: busy > 0 };
  }
  // Yellow, not blue: a verdict this old means the rotation is not reaching
  // this project, which is a finding about the watcher rather than a project
  // simply waiting its turn.
  if (Date.now() - deep.at > DEEP_STALE_AFTER_MS) {
    return {
      icon: ":large_yellow_circle:",
      label: `${load} · 심층 결과가 오래됨 — 마지막 정상 확인이 ${age} 전 (점검이 이 프로젝트에 닿지 않는지 보세요)`,
      broken: false,
      stale: true,
      busy: busy > 0,
    };
  }
  return { icon: ":large_green_circle:", label: `${load} · 심층 정상 ${secs(deep.ms)} (${age} 전)`, broken: false, busy: busy > 0 };
}

function projectLines(health: Health, state?: State): string {
  return health.expected.map((title) => {
    const verdict = verdictFor(title, health, state);
    const busyMark = verdict.busy ? " :hourglass_flowing_sand:" : "";
    return `   ${verdict.icon} ${title}${busyMark} — ${verdict.label}`;
  }).join("\n");
}

// One line of counts, no icon row.
//
// This used to render the icons horizontally as well, which duplicated the
// per-project list directly beneath it — the same seven icons twice, and the
// horizontal row could not say WHICH project was which. The list does the
// naming; this does the counting.
function projectStrip(health: Health, state?: State): string {
  if (!health.expected.length) return "";
  const verdicts = health.expected.map((title) => verdictFor(title, health, state));
  const total = health.expected.length;
  const broken = verdicts.filter((verdict) => verdict.broken).length;
  const stale = verdicts.filter((verdict) => verdict.stale).length;
  // Waiting is counted apart from healthy: folding it in would have the line
  // claim a project is fine on evidence nobody has gathered.
  const waiting = verdicts.filter((verdict) => !verdict.broken && !verdict.stale
    && verdict.icon === ":large_blue_circle:").length;
  const healthy = total - broken - stale - waiting;
  // "0/7 정상" is technically true right after a restart and reads as "all
  // seven are broken", which is the impression this line exists to prevent. A
  // fraction only means anything when every project is accounted for.
  if (!broken && !stale && !waiting) return `:large_green_circle: 전체 ${total}/${total} 정상`;
  const parts: string[] = [];
  if (healthy) parts.push(`:large_green_circle: 정상 ${healthy}`);
  if (broken) parts.push(`:red_circle: 이상 ${broken}`);
  if (stale) parts.push(`:large_yellow_circle: 오래됨 ${stale}`);
  if (waiting) {
    const rotation = Math.round((DEEP_MS * total) / 60_000);
    parts.push(`:large_blue_circle: 심층 대기 ${waiting} (한 바퀴 ~${rotation}분)`);
  }
  return parts.join("  ·  ");
}

function healthyText(state: State, health: Health): string {
  const deep = health.deep ? `\n• 심층 점검: ${displayName(health.deep.project)} — ${health.deep.detail}` : "";
  return `:large_green_circle: *Figma 헬스체크 · 이상 없음*\n`
    + `${projectStrip(health, state)}\n`
    + `• 연결: ${coverage(health)}\n`
    + `• 마지막 확인: ${clock()} · 점검 ${state.checks}회 · 연속 정상 ${humanSince(state.since)}${deep}\n`
    // This watcher runs on the machine it watches, so it cannot report that
    // machine dying — the card simply stops changing. Saying when the next
    // rewrite is due makes that silence legible instead of ambiguous: a card
    // whose promised time has passed is itself the alert.
    + `• 다음 갱신 예정: ${clock(Date.now() + HEALTHY_UPDATE_MS)} (이 시각이 지나도 그대로면 워처나 macmini-1 자체를 의심하세요)\n`
    + `• 프로젝트별 상태:\n${projectLines(health, state)}\n`
    + `:link: ${consoleLink}  ·  _워처 ${BUILD} · 기동 ${clock(STARTED_AT)}_`;
}

function degradedText(state: State, health: Health): string {
  const mention = ALERT_USER ? `<@${ALERT_USER}> ` : "";
  const lines = [`:red_circle: ${mention}*Figma 헬스체크 · 이상 감지*`];
  // The blast radius goes above the cause. Whoever is being pulled in wants to
  // know how much is broken before they read what broke.
  if (health.relayUp && health.expected.length) lines.push(projectStrip(health, state));
  if (!health.relayUp) lines.push("• 릴레이에 접속할 수 없습니다 (macmini-1:3055)");
  if (health.missing.length) lines.push(`• 플러그인 없음: ${health.missing.map(displayName).join(", ")}`);
  if (health.failingDeep?.length) {
    lines.push(`• 심층 점검 실패: ${health.failingDeep.map(displayName).join(", ")} (자세한 내용은 아래 프로젝트별 상태)`);
  } else if (health.deep && !health.deep.ok) {
    lines.push(`• 이번 심층 점검 실패: ${displayName(health.deep.project)} — ${health.deep.detail}`);
  }
  lines.push(`• 최초 이상 감지: ${clock(state.since)} (${humanSince(state.since)} 경과) · 확인 ${state.checks}회`);
  // An alert that names only what broke leaves the reader asking whether the
  // rest is fine — which is the first thing anyone wants to know when they are
  // pulled in. The all-clear card already lists every project; the alert needs
  // it more.
  if (health.relayUp && health.expected.length) {
    lines.push(`• 프로젝트별 상태:\n${projectLines(health, state)}`);
  }
  lines.push(`• 복구: 브로커 액션 \`figma-open-projects\` (macmini-1). 이미 복구 중이면 exit 75 로 나옵니다.`);
  lines.push(`:link: ${consoleLink}  ·  _워처 ${BUILD} · 기동 ${clock(STARTED_AT)}_`);
  return lines.join("\n");
}

function recoveredText(state: State, health: Health): string {
  return `:white_check_mark: *Figma 헬스체크 · 복구됨*\n`
    + `${projectStrip(health, state)}\n`
    + `• ${humanSince(state.since)} 만에 정상 — 연결 ${coverage(health)}\n`
    + `• 확인: ${clock()}\n`
    + `:link: ${consoleLink}`;
}


// Each change goes into the incident card's thread as its own reply. The card
// is rewritten in place, so it can only ever show the current shape of the
// outage — the sequence that produced it would otherwise be lost, and that
// sequence is what says "this one broke overnight, that one broke just now".
async function reportChanges(state: State): Promise<void> {
  if (!pendingChanges.length) return;
  const parent = state.incidentTs;
  if (!parent) return;   // nothing to hang them off yet; keep them for the next tick
  const text = pendingChanges.join("\n");
  const posted = await slack("chat.postMessage", { text, thread_ts: parent });
  if (!posted?.ok) return;
  pendingChanges = [];
  // Once everything is back, the incident is closed and the next one starts a
  // fresh thread. Released here rather than on the transition, so the final
  // recovery lines still land under the alert they belong to.
  if (state.status === "healthy" && Object.keys(state.downSince).length === 0) {
    state.incidentTs = null;
  }
}

// A new message notifies; an edit does not. So transitions post, and steady
// state edits in place — which is the whole point of keeping messageTs.
async function report(state: State, health: Health): Promise<void> {
  const status: State["status"] = health.ok ? "healthy" : "degraded";
  const changed = state.status !== status;

  if (changed) {
    if (state.status === "degraded" && status === "healthy") {
      await slack("chat.postMessage", { text: recoveredText(state, health) });
    }
    state.status = status;
    state.since = Date.now();
    state.checks = 1;
    // Persist the transition BEFORE announcing it. This process is restarted
    // often — launchd brings it back on any exit — and saving afterwards meant
    // a restart between the post and the save left "healthy" on disk, so the
    // next process decided the very same outage was new and paged again. That
    // is the duplicate alert. messageTs stays null until the post succeeds, so
    // a post that fails is retried by the throttled path rather than lost.
    state.messageTs = null;
    saveState(state);
    const posted = await slack("chat.postMessage", {
      text: status === "healthy" ? healthyText(state, health) : degradedText(state, health),
    });
    state.messageTs = posted?.ts ?? null;
    // The alert card becomes the thread every change in this outage is written
    // into, and stays so until the outage ends — the recoveries that close it
    // belong under the alert, not under the all-clear that replaces the card.
    if (status === "degraded") state.incidentTs = state.messageTs;
    state.lastPostedAt = Date.now();
    return;
  }

  const throttle = status === "healthy" ? HEALTHY_UPDATE_MS : DEGRADED_UPDATE_MS;
  if (Date.now() - state.lastPostedAt < throttle) return;
  const text = status === "healthy" ? healthyText(state, health) : degradedText(state, health);
  if (state.messageTs) {
    const updated = await slack("chat.update", { ts: state.messageTs, text });
    // A message that can no longer be edited (deleted, too old) should not
    // silently stop the reporting — start a new one instead. A transient
    // failure is not that, and returning here without touching lastPostedAt
    // retries the same edit on the next tick.
    if (replaceable(updated)) {
      const posted = await slack("chat.postMessage", { text });
      state.messageTs = posted?.ts ?? null;
    } else if (!updated?.ok) {
      return;
    }
  } else {
    const posted = await slack("chat.postMessage", { text });
    state.messageTs = posted?.ts ?? null;
  }
  state.lastPostedAt = Date.now();
}


// --- outliers --------------------------------------------------------------
// The thread record is for reading on purpose; an outlier has to come and find
// someone, which means a new message rather than an edit. Alert once per
// episode: a probe that stays slow should not keep ringing, so this re-arms
// only after a run comes back inside the normal range.
const SLOW_FACTOR = Number(process.env.HEALTH_SLOW_FACTOR || 3);
const SLOW_FLOOR_MS = Number(process.env.HEALTH_SLOW_FLOOR_MS || 5_000);
const SLOW_MIN_SAMPLES = Number(process.env.HEALTH_SLOW_MIN_SAMPLES || 5);

function baselineFor(series: number[]): number | null {
  // Exclude the sample being judged, and require enough history that a couple
  // of early runs cannot define "normal".
  const prior = series.slice(0, -1).slice(-SPEED_WINDOW);
  return prior.length >= SLOW_MIN_SAMPLES ? mean(prior) : null;
}

// One alert per slowdown per project, and not more than once per cooldown.
// A project whose normal is slow is not an outlier for being slow; a project
// that gets slower than ITS normal is, once, and then the card carries it.
const SLOW_COOLDOWN_MS = Number(process.env.HEALTH_SLOW_COOLDOWN_MS || 6 * 60 * 60_000);
// A relative baseline alone never notices a project that degrades gradually:
// 1s, 2s, 4s, 8s, 30s stays under 3x its own trailing mean at every step. Past
// this, a probe counts as slow whatever the project's history says. CA_Product's
// normal is ~16s, so this does not bring back the per-rotation alert.
const SLOW_CEILING_MS = Number(process.env.HEALTH_SLOW_CEILING_MS || 30_000);

async function reportOutlier(state: State, health: Health): Promise<void> {
  const entry = state.deepHistory[state.deepHistory.length - 1];
  if (!entry || !entry.ok) return;
  const key = nameKey(entry.project);
  const series = state.deepDurations[key] || [];
  const latest = series[series.length - 1];
  const base = baselineFor(series);
  if (latest == null || base == null) return;

  const isOutlier = (latest > base * SLOW_FACTOR && latest > SLOW_FLOOR_MS) || latest > SLOW_CEILING_MS;
  if (!isOutlier) {
    delete state.slowSince[key];   // THIS project is back in range: re-arm it
    return;
  }
  if (!state.slowSince[key]) state.slowSince[key] = Date.now();
  // One alert per episode. An episode already announced stays quiet; one that
  // began inside the cooldown is not dropped but deferred — announced once the
  // cooldown ends if it is still going, instead of staying silent for its whole
  // life because the flag was set while the cooldown held it back.
  if ((state.slowAlertedAt[key] || 0) >= state.slowSince[key]) return;
  if (Date.now() - (state.slowAlertedAt[key] || 0) < SLOW_COOLDOWN_MS) return;
  state.slowAlertedAt[key] = Date.now();

  const mention = ALERT_USER ? `<@${ALERT_USER}> ` : "";
  await slack("chat.postMessage", {
    text: `:warning: ${mention}*Figma 헬스체크 · 응답이 느려졌습니다*\n`
      + `• ${displayName(entry.project)} 심층 점검 ${secs(latest)} — 이 프로젝트의 최근 평균 ${secs(base)}의 `
      + `${(latest / base).toFixed(1)}배\n`
      + `• 아직 실패는 아닙니다. 계속 느려지면 플러그인이 먹통이 되기 전 단계일 수 있습니다.\n`
      + `• 같은 프로젝트는 ${Math.round(SLOW_COOLDOWN_MS / 3_600_000)}시간 동안 다시 알리지 않습니다. 지금 속도는 상태 카드에 계속 표시됩니다.\n`
      + `• 확인: ${clock()}\n`
      + `:link: ${consoleLink}`,
  });
}

// --- loop ------------------------------------------------------------------
let state = loadState();
let last: Health = { ok: false, relayUp: false, expected: [], live: [], missing: [], load: [], shallowMs: 0, deep: null };
let lastDeepAt = 0;
const deepEvery = () => (last.deep && !last.deep.ok ? DEEP_RETRY_MS : DEEP_MS);

// Three things call tick(): the interval, startup, and /check. Overlapping
// runs would each read the status before either wrote it, and both would treat
// the same change as new.
// Changes waiting to be written into the incident thread. The card shows the
// current shape of the outage; the thread shows how it got there, which is the
// part that is lost once the card is rewritten.
let pendingChanges: string[] = [];
let ticking = false;

// The backstop behind every individual timeout.
//
// Bounding each call fixes the hang that happened; it does not fix the next one,
// which will be some await nobody thought to bound. So the loop itself is timed:
// a tick running longer than any legitimate tick can is treated as wedged, and
// the process exits. launchd has KeepAlive on this job and restarts it within
// ThrottleInterval, and all state is on disk, so the cost of a false trip is
// one restart — against a silent watcher, which is the one failure this service
// exists to make impossible.
//
// 20 minutes is well past a real worst case: two deep probes, each a handful of
// 45s-bounded commands plus a 90s export budget, is on the order of 11 minutes.
const TICK_STUCK_MS = Number(process.env.HEALTH_TICK_STUCK_MS || 20 * 60_000);
let tickStartedAt = 0;

async function tick(): Promise<boolean> {
  if (ticking) return false;
  ticking = true;
  tickStartedAt = Date.now();
  try {
    await runTick();
    return true;
  } finally {
    ticking = false;
  }
}

setInterval(() => {
  if (!ticking) return;
  const stuckFor = Date.now() - tickStartedAt;
  if (stuckFor < TICK_STUCK_MS) return;
  console.error(`[health] tick has been running for ${Math.round(stuckFor / 1000)}s — `
    + `treating the loop as wedged and exiting so launchd restarts it`);
  process.exit(70);
}, 60_000);

async function runTick(): Promise<void> {
  const health = await shallowCheck();
  state.checks += 1;
  state.shallowHistory.push(health.shallowMs);
  if (state.shallowHistory.length > SPEED_WINDOW * 3) {
    state.shallowHistory.splice(0, state.shallowHistory.length - SPEED_WINDOW * 3);
  }

  // Streak damping: a project that blinks out for one poll is usually a plugin
  // reconnecting on its own, and paging a human for that trains them to ignore
  // the channel.
  for (const name of health.expected) {
    state.streak[name] = health.missing.includes(name) ? (state.streak[name] || 0) + 1 : 0;
  }
  const confirmed = health.missing.filter((name) => (state.streak[name] || 0) >= FAIL_STREAK);

  // Per-project transitions, recorded as they happen. Without this the card
  // could only say when the incident began, so anything that broke later wore
  // the first failure's timestamp.
  for (const name of confirmed) {
    if (!state.downSince[name]) {
      state.downSince[name] = Date.now();
      pendingChanges.push(`:red_circle: ${clock()} · ${displayName(name)} 플러그인 끊김`);
    }
  }
  for (const name of Object.keys(state.downSince)) {
    if (!confirmed.includes(name)) {
      const downFor = humanSince(state.downSince[name]);
      delete state.downSince[name];
      pendingChanges.push(`:white_check_mark: ${clock()} · ${displayName(name)} 복구 (${downFor} 만에)`);
    }
  }
  const damped: Health = { ...health, missing: confirmed, ok: health.relayUp && confirmed.length === 0 };

  if (damped.ok && Date.now() - lastDeepAt >= deepEvery()) {
    lastDeepAt = Date.now();
    const deepStarted = Date.now();
    damped.deep = await deepCheck(state);
    if (damped.deep) {
      if (damped.deep.ms == null) damped.deep.ms = Date.now() - deepStarted;
      // Guard the boundary, not just the producer. One bad sample poisons the
      // next twenty readings and can page someone as an "outlier", so a value
      // that is not a plausible duration never enters the record.
      if (usableMs(damped.deep.ms) || !damped.deep.ok) {
        state.deepHistory.push({
          at: Date.now(),
          project: damped.deep.project,
          ok: damped.deep.ok && usableMs(damped.deep.ms),
          ms: damped.deep.ms ?? 0,
        });
        if (damped.deep.ok && usableMs(damped.deep.ms)) {
          const key = nameKey(damped.deep.project);
          const series = (state.deepDurations[key] ||= []);
          series.push(damped.deep.ms as number);
          if (series.length > SPEED_WINDOW) series.splice(0, series.length - SPEED_WINDOW);
        }
      }
      if (state.deepHistory.length > SPEED_WINDOW * 3) state.deepHistory.splice(0, state.deepHistory.length - SPEED_WINDOW * 3);
      state.deepResults[nameKey(damped.deep.project)] = {
        at: Date.now(),
        ok: !!damped.deep.ok,
        ms: damped.deep.ms ?? 0,
        detail: damped.deep.detail ?? "",
      };
      // deepHistory is trimmed just above; this needs the same care for a
      // different reason. Keys are project names, so a rename or a project
      // leaving defaultProjectIDs would otherwise leave its verdict — detail
      // string and all — in the state file forever.
      const expectedKeys = new Set(health.expected.map(nameKey));
      for (const map of [state.deepResults, state.deepDurations, state.slowSince, state.slowAlertedAt] as Record<string, unknown>[]) {
        for (const key of Object.keys(map)) {
          if (!expectedKeys.has(key)) delete map[key];
        }
      }
    }
  } else {
    damped.deep = last.deep;   // keep the last deep result visible on the card
  }
  // The deep verdict has to outlive the tick that produced it. Applying it only
  // on the tick that ran it made a wedged plugin flap: degraded for one tick,
  // then healthy again on the next shallow poll, which would alert and "recover"
  // once per deep interval. It stays authoritative until a later deep check
  // replaces it — and after a failure we retry sooner so a real recovery is not
  // hidden behind the full interval.
  if (damped.deep && !damped.deep.ok) damped.ok = false;

  // And it has to outlive the PROJECT that produced it, not just the tick.
  //
  // damped.deep is whichever single project this turn happened to probe, so
  // once the rotation moved on, an earlier failure stopped counting: the card
  // said "이상 없음" in its headline while listing a red GW_Product three lines
  // below and tallying "1개 이상". Nobody can act on a card that contradicts
  // itself. Any project whose last deep verdict is a failure keeps the whole
  // check degraded until a later probe of THAT project replaces it.
  const failingDeep = health.expected.filter(
    (title) => state.deepResults[nameKey(title)]?.ok === false);
  if (failingDeep.length) damped.ok = false;
  damped.failingDeep = failingDeep;

  last = damped;
  await report(state, damped);
  await reportChanges(state);
  await reportSpeed(state);
  await reportOutlier(state, damped);
  saveState(state);
}

setInterval(() => { void tick().catch((error) => console.error("[health] tick failed:", error)); }, SHALLOW_MS);
void tick().catch((error) => console.error("[health] first tick failed:", error));

// Small status surface so this can be a supervised tunnel service and so its
// own state is inspectable without reading the Slack channel.
Bun.serve({
  port: PORT,
  // /check runs the deep probe inline and a page enumeration plus an image
  // export takes longer than Bun's 10s default, which closed the connection
  // mid-probe and reported an empty reply for a check that had actually passed.
  idleTimeout: 120,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // Render the cards without sending them anywhere.
    //
    // Card layout was previously only verifiable by posting to #dev_noti_figma
    // and looking, which means every wording change costs the channel a
    // message. This returns exactly what Slack would receive, from the live
    // state, so a layout can be read before anyone else sees it.
    if (url.pathname === "/preview") {
      const health = last;
      return new Response(JSON.stringify({
        status: state.status,
        strip: health ? projectStrip(health, state) : null,
        healthy: health ? healthyText(state, health) : null,
        degraded: health ? degradedText(state, health) : null,
        recovered: health ? recoveredText(state, health) : null,
        deepResults: state.deepResults,
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }
    // Forces the deep probe now instead of waiting out the interval — for
    // verifying a deployment, and for checking a specific project by hand
    // after a repair without watching the clock.
    if (url.pathname === "/check") {
      lastDeepAt = 0;
      return tick()
        .then((ran) => new Response(JSON.stringify({ ran, status: state.status, last }, null, 2),
          { headers: { "Content-Type": "application/json" } }))
        .catch((error) => new Response(JSON.stringify({ ran: false, error: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } }));
    }
    return new Response(JSON.stringify({
      status: state.status, since: state.since, checks: state.checks,
      slackConfigured: Boolean(SLACK_TOKEN && SLACK_CHANNEL),
      intervals: { shallowMs: SHALLOW_MS, deepMs: DEEP_MS, healthyUpdateMs: HEALTHY_UPDATE_MS },
      speed: {
        window: SPEED_WINDOW,
        shallow: trend(state.shallowHistory),
        deep: trend(state.deepHistory.filter((entry) => entry.ok).map((entry) => entry.ms)),
        recentDeep: state.deepHistory.slice(-10),
      },
      last,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  },
});
console.log(`[health] watching ${RELAY_HTTP} every ${SHALLOW_MS}ms, deep every ${DEEP_MS}ms, status on :${PORT}`);
