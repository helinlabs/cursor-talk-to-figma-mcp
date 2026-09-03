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
  deepCursor: number;
  deepPoolSize: number;
  // Recent timings, newest last, kept separately because the two probes sample
  // at very different rates. A probe that is merely getting slower is the
  // interesting signal — it shows up here long before anything fails outright.
  slowActive: boolean;           // an outlier has been reported and not yet cleared
  speedTs: string | null;        // the speed record living in the card's thread
  speedParentTs: string | null;
  speedPostedAt: number;
  shallowHistory: number[];
  deepHistory: Array<{ at: number; project: string; ok: boolean; ms: number }>;
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
    };
  } catch {
    return blankState();
  }
}
function blankState(): State {
  return { status: "unknown", messageTs: null, checks: 0, since: Date.now(), lastPostedAt: 0, slowActive: false, speedTs: null, speedParentTs: null, speedPostedAt: 0, streak: {}, deepCursor: 0, deepPoolSize: 1, shallowHistory: [], deepHistory: [] };
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
  const project = projects_[state.deepCursor % projects_.length];
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
    let target = childrenOf(info).find((child: any) => child?.id) ?? null;

    // GW_Product's current page is empty, so the probe kept reporting "no
    // image target" and its export path was never actually exercised — the
    // heaviest thing the plugin does went untested on the file most likely to
    // break. get_document_info takes a pageId, so look at a couple of other
    // pages without moving anyone's current page.
    if (!target) {
      for (const page of list.filter((entry: any) => entry?.id && entry.id !== currentId).slice(0, 2)) {
        const elsewhere: any = await timed("read2", () =>
          runCommand(channel, "get_document_info", { pageId: page.id }, DEEP_COMMAND_MS));
        target = childrenOf(elsewhere).find((child: any) => child?.id) ?? null;
        if (target) break;
      }
    }
    if (!target) {
      return { project: name, ok: true, ms: Date.now() - probeStarted,
        detail: `${loadNote} · ${list.length} pages, selection ok, 내용 있는 페이지 없음 · ${timings.join(" · ")}` };
    }

    const image = await timed("image", () => runCommand(channel, "export_node_as_image",
      { nodeId: target.id, format: "PNG", scale: 0.05 }, DEEP_COMMAND_MS));
    const bytes = imageBytes(image);
    if (!bytes) {
      return { project: name, ok: false, ms: Date.now() - probeStarted,
        detail: `image export returned nothing · ${timings.join(" · ")}` };
    }
    return { project: name, ok: true, ms: Date.now() - probeStarted,
      detail: `${loadNote} · ${list.length} pages, selection ok, node read, image ${sizeOf(bytes)} · ${timings.join(" · ")}` };
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
async function slack(method: string, body: any): Promise<any> {
  if (!SLACK_TOKEN || !SLACK_CHANNEL) return { ok: false, error: "slack not configured" };
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: SLACK_CHANNEL, ...body }),
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
  if (!payload.ok) console.error(`[health] slack ${method} failed:`, payload.error);
  return payload;
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
    if (!updated?.ok) state.speedTs = null;
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
function projectLines(health: Health): string {
  const byName = new Map(health.load.map((entry) => [nameKey(entry.name), entry]));
  return health.expected.map((title) => {
    const entry = [...byName.entries()].find(([key]) => key.includes(nameKey(title)) || nameKey(title).includes(key))?.[1];
    if (!entry) return `   :red_circle: ${title} — 플러그인 없음`;
    const busy = entry.running + entry.pending;
    const detail = busy
      ? `처리 ${entry.running} · 대기 ${entry.pending} · 최장 ${secs(entry.oldestQueuedMs)}`
      : "유휴";
    return `   ${busy ? ":hourglass_flowing_sand:" : ":white_small_square:"} ${title} — ${detail}`;
  }).join("\n");
}

function healthyText(state: State, health: Health): string {
  const deep = health.deep ? `\n• 심층 점검: ${displayName(health.deep.project)} — ${health.deep.detail}` : "";
  return `:large_green_circle: *Figma 헬스체크 · 이상 없음*\n`
    + `• 연결: ${coverage(health)}\n`
    + `• 마지막 확인: ${clock()} · 점검 ${state.checks}회 · 연속 정상 ${humanSince(state.since)}${deep}\n`
    // This watcher runs on the machine it watches, so it cannot report that
    // machine dying — the card simply stops changing. Saying when the next
    // rewrite is due makes that silence legible instead of ambiguous: a card
    // whose promised time has passed is itself the alert.
    + `• 다음 갱신 예정: ${clock(Date.now() + HEALTHY_UPDATE_MS)} (이 시각이 지나도 그대로면 워처나 macmini-1 자체를 의심하세요)\n`
    + `• 프로젝트별 부하:\n${projectLines(health)}\n`
    + `:link: ${consoleLink}`;
}

function degradedText(state: State, health: Health): string {
  const mention = ALERT_USER ? `<@${ALERT_USER}> ` : "";
  const lines = [`:red_circle: ${mention}*Figma 헬스체크 · 이상 감지*`];
  if (!health.relayUp) lines.push("• 릴레이에 접속할 수 없습니다 (macmini-1:3055)");
  if (health.missing.length) lines.push(`• 플러그인 없음: ${health.missing.map(displayName).join(", ")}`);
  if (health.deep && !health.deep.ok) lines.push(`• 응답 없음: ${displayName(health.deep.project)} — ${health.deep.detail}`);
  lines.push(`• 시작: ${clock(state.since)} · 지속 ${humanSince(state.since)} · 확인 ${state.checks}회`);
  lines.push(`• 복구: 브로커 액션 \`figma-open-projects\` (macmini-1). 이미 복구 중이면 exit 75 로 나옵니다.`);
  lines.push(`:link: ${consoleLink}`);
  return lines.join("\n");
}

function recoveredText(state: State, health: Health): string {
  return `:white_check_mark: *Figma 헬스체크 · 복구됨*\n`
    + `• ${humanSince(state.since)} 만에 정상 — 연결 ${coverage(health)}\n`
    + `• 확인: ${clock()}\n`
    + `:link: ${consoleLink}`;
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
    state.lastPostedAt = Date.now();
    return;
  }

  const throttle = status === "healthy" ? HEALTHY_UPDATE_MS : DEGRADED_UPDATE_MS;
  if (Date.now() - state.lastPostedAt < throttle) return;
  const text = status === "healthy" ? healthyText(state, health) : degradedText(state, health);
  if (state.messageTs) {
    const updated = await slack("chat.update", { ts: state.messageTs, text });
    // A message that can no longer be edited (deleted, too old) should not
    // silently stop the reporting — start a new one instead.
    if (!updated?.ok) {
      const posted = await slack("chat.postMessage", { text });
      state.messageTs = posted?.ts ?? null;
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

async function reportOutlier(state: State, health: Health): Promise<void> {
  const durations = state.deepHistory.filter((entry) => entry.ok).map((entry) => entry.ms);
  const latest = durations[durations.length - 1];
  const base = baselineFor(durations);
  if (latest == null || base == null) return;

  const isOutlier = latest > base * SLOW_FACTOR && latest > SLOW_FLOOR_MS;
  if (!isOutlier) {
    state.slowActive = false;   // back in range: re-arm for the next episode
    return;
  }
  if (state.slowActive) return;
  state.slowActive = true;

  const entry = state.deepHistory[state.deepHistory.length - 1];
  const mention = ALERT_USER ? `<@${ALERT_USER}> ` : "";
  await slack("chat.postMessage", {
    text: `:warning: ${mention}*Figma 헬스체크 · 응답이 느려졌습니다*\n`
      + `• ${displayName(entry.project)} 심층 점검 ${secs(latest)} — 최근 평균 ${secs(base)}의 `
      + `${(latest / base).toFixed(1)}배\n`
      + `• 아직 실패는 아닙니다. 계속 느려지면 플러그인이 먹통이 되기 전 단계일 수 있습니다.\n`
      + `• 확인: ${clock()} · 상세는 상태 카드의 스레드에 있습니다.\n`
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
let ticking = false;

async function tick(): Promise<boolean> {
  if (ticking) return false;
  ticking = true;
  try {
    await runTick();
    return true;
  } finally {
    ticking = false;
  }
}

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
      }
      if (state.deepHistory.length > SPEED_WINDOW * 3) state.deepHistory.splice(0, state.deepHistory.length - SPEED_WINDOW * 3);
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

  last = damped;
  await report(state, damped);
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
