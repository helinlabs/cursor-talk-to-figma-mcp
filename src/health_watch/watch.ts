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

const SHALLOW_MS = Number(process.env.HEALTH_SHALLOW_MS || 60_000);
const DEEP_MS = Number(process.env.HEALTH_DEEP_MS || 15 * 60_000);
// After a deep failure the picture is stale in the direction that matters, so
// re-ask sooner than the normal cadence.
const DEEP_RETRY_MS = Number(process.env.HEALTH_DEEP_RETRY_MS || 2 * 60_000);
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
  deep: { project: string; ok: boolean; detail: string } | null;
};

type State = {
  status: "healthy" | "degraded" | "unknown";
  messageTs: string | null;      // the rolling message we keep rewriting
  checks: number;                // checks folded into the current message
  since: number;                 // when the current status began
  lastPostedAt: number;
  streak: Record<string, number>;
  deepCursor: number;
};

function loadState(): State {
  try {
    return { ...blankState(), ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return blankState();
  }
}
function blankState(): State {
  return { status: "unknown", messageTs: null, checks: 0, since: Date.now(), lastPostedAt: 0, streak: {}, deepCursor: 0 };
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
function expectedProjects(): string[] {
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
  const expected = expectedProjects();
  try {
    await getJson("/health");
  } catch (error) {
    return { ok: false, relayUp: false, expected, live: [], missing: expected, deep: null };
  }
  let live: string[] = [];
  try {
    const payload = await getJson("/projects");
    live = (payload.projects || [])
      .filter((project: any) => project.connectionCount > 0)
      .map((project: any) => String(project.name));
  } catch {
    return { ok: false, relayUp: true, expected, live: [], missing: expected, deep: null };
  }
  const missing = expected.filter((name) => !isPresent(name, live));
  return { ok: missing.length === 0, relayUp: true, expected, live, missing, deep: null };
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

async function deepCheck(state: State): Promise<Health["deep"]> {
  let projects: any[] = [];
  try {
    projects = ((await getJson("/projects")).projects || [])
      .filter((project: any) => project.connectionCount > 0 && project.recommendedChannel);
  } catch {
    return null;
  }
  if (!projects.length) return null;
  const project = projects[state.deepCursor % projects.length];
  state.deepCursor = (state.deepCursor + 1) % Math.max(1, projects.length);
  const name = String(project.name);
  try {
    // Page enumeration is the cheapest thing that proves the plugin is running
    // real document code rather than just holding a socket open.
    const pages = await runCommand(project.recommendedChannel, "list_pages", {});
    const list: any[] = Array.isArray(pages) ? pages : (pages?.pages || []);
    if (!list.length) return { project: name, ok: false, detail: "plugin answered but reported no pages" };
    // Then read one node back, which is the path every real caller uses.
    const pageId = list[0]?.id ?? list[0]?.nodeId;
    if (!pageId) return { project: name, ok: true, detail: `${list.length} pages (no id to re-read)` };
    await runCommand(project.recommendedChannel, "get_node_info", { nodeId: pageId });
    return { project: name, ok: true, detail: `${list.length} pages, node read back` };
  } catch (error) {
    return { project: name, ok: false, detail: error instanceof Error ? error.message : String(error) };
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

function healthyText(state: State, health: Health): string {
  const deep = health.deep ? ` · 심층 ${health.deep.project} ${health.deep.ok ? "정상" : "실패"}` : "";
  return `:large_green_circle: *Figma 헬스체크 · 이상 없음*\n`
    + `• 연결: ${health.live.length}/${health.expected.length} 프로젝트\n`
    + `• 마지막 확인: ${clock()} · 점검 ${state.checks}회 · 연속 정상 ${humanSince(state.since)}${deep}`;
}

function degradedText(state: State, health: Health): string {
  const mention = ALERT_USER ? `<@${ALERT_USER}> ` : "";
  const lines = [`:red_circle: ${mention}*Figma 헬스체크 · 이상 감지*`];
  if (!health.relayUp) lines.push("• 릴레이에 접속할 수 없습니다 (macmini-1:3055)");
  if (health.missing.length) lines.push(`• 플러그인 없음: ${health.missing.join(", ")}`);
  if (health.deep && !health.deep.ok) lines.push(`• 응답 없음: ${health.deep.project} — ${health.deep.detail}`);
  lines.push(`• 시작: ${clock(state.since)} · 지속 ${humanSince(state.since)} · 확인 ${state.checks}회`);
  lines.push(`• 복구: 브로커 액션 \`figma-open-projects\` (macmini-1). 이미 복구 중이면 exit 75 로 나옵니다.`);
  return lines.join("\n");
}

function recoveredText(state: State, health: Health): string {
  return `:white_check_mark: *Figma 헬스체크 · 복구됨*\n`
    + `• ${humanSince(state.since)} 만에 정상 — 연결 ${health.live.length}/${health.expected.length}\n`
    + `• 확인: ${clock()}`;
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

// --- loop ------------------------------------------------------------------
let state = loadState();
let last: Health = { ok: false, relayUp: false, expected: [], live: [], missing: [], deep: null };
let lastDeepAt = 0;
const deepEvery = () => (last.deep && !last.deep.ok ? DEEP_RETRY_MS : DEEP_MS);

async function tick(): Promise<void> {
  const health = await shallowCheck();
  state.checks += 1;

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
    damped.deep = await deepCheck(state);
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
  saveState(state);
}

setInterval(() => { void tick().catch((error) => console.error("[health] tick failed:", error)); }, SHALLOW_MS);
void tick().catch((error) => console.error("[health] first tick failed:", error));

// Small status surface so this can be a supervised tunnel service and so its
// own state is inspectable without reading the Slack channel.
Bun.serve({
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      status: state.status, since: state.since, checks: state.checks,
      slackConfigured: Boolean(SLACK_TOKEN && SLACK_CHANNEL),
      intervals: { shallowMs: SHALLOW_MS, deepMs: DEEP_MS, healthyUpdateMs: HEALTHY_UPDATE_MS },
      last,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  },
});
console.log(`[health] watching ${RELAY_HTTP} every ${SHALLOW_MS}ms, deep every ${DEEP_MS}ms, status on :${PORT}`);
