// Keep observation separate from diagnosis. The plugin's local timer does not
// prove that Figma rejected the request (nor that any document nodes are lost).
export const LINK_TIMEOUT_MS = 15_000;
export function linkFailureDetail(link) {
  const error = String(link?.error || '응답 형식 확인 필요');
  if (/Unable to establish connection to Figma/i.test(error)) {
    return '문서 서버 조회 실패 — Figma API가 연결 오류를 반환함. 플러그인 연결과 별도 상태이며 파일 탭 재연결이 필요할 수 있음';
  }
  if (/no answer in|timeout|timed out/i.test(error)) {
    return '문서 서버 응답 지연 — 제한 시간 내 조회 미완료, 연결 단절 여부 미확인';
  }
  return `문서 서버 조회 오류 — ${shortText(error, 140)}`;
}

export function shortText(text, limit = 180) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
}

// Old persisted results must stop repeating the old, unproven diagnosis too.
export function detailSummary(detail) {
  const text = String(detail || '');
  if (/문서가 피그마 서버와 끊겨/.test(text)) {
    return linkFailureDetail({error: /Unable to establish connection to Figma after/.test(text)
      ? 'Unable to establish connection to Figma' : 'no answer in'});
  }
  return shortText(text);
}

// Slack's limit on chat.update is 4,000 UTF-8 *bytes* of text, not 40,000
// characters. Measured on #dev_noti_figma 2026-11-08: the degraded card at
// 2,400 chars / 4,205 bytes → msg_too_long; the same card cut to 3,990 bytes →
// ok, 4,008 bytes → msg_too_long; 1,543 hangul (4,271 bytes) → msg_too_long,
// 4,471 ASCII chars → msg_too_long. Korean is 3 bytes a character, so the old
// 3,500-*character* bound let every degraded card through to a rejection —
// 10,517 of them in health.log, and the card only ever showed the 1,500-char
// retry, cut before the repair action and the console link. Bound bytes.
export const SLACK_TEXT_MAX_BYTES = 3_900;
export const SLACK_RETRY_MAX_BYTES = 2_000;
const encoder = new TextEncoder();
export const slackBytes = (text) => encoder.encode(String(text ?? '')).length;

const OMITTED_SUFFIX = '\n… 상세 결과는 헬스체크 /preview에서 확인하세요.';

// Cut on whole code points (never half an emoji or hangul syllable) so the
// result, suffix included, fits in `limitBytes`.
function headWithin(chars, limitBytes) {
  let used = 0, end = 0;
  for (; end < chars.length; end++) {
    const size = slackBytes(chars[end]);
    if (used + size > limitBytes) break;
    used += size;
  }
  return chars.slice(0, end).join('');
}

export function boundedSlackText(text, limitBytes = SLACK_TEXT_MAX_BYTES) {
  const whole = String(text ?? '');
  if (slackBytes(whole) <= limitBytes) return whole;
  const head = headWithin(Array.from(whole), Math.max(0, limitBytes - slackBytes(OMITTED_SUFFIX)));
  // Do not cut a Slack URL/mention halfway through.
  const lineEnd = head.lastIndexOf('\n');
  return (lineEnd > 0 ? head.slice(0, lineEnd) : head) + OMITTED_SUFFIX;
}

// A card whose tail is the part people act on (the repair action, the console
// link) must not lose that tail to a long middle. Keep head and tail whole and
// drop body lines from the end, saying how many went, before falling back to a
// blind cut.
export function fitSlackCard({head = [], body = [], tail = []}, limitBytes = SLACK_TEXT_MAX_BYTES) {
  const join = (lines) => lines.join('\n');
  const whole = join([...head, ...body, ...tail]);
  if (slackBytes(whole) <= limitBytes) return whole;
  for (let keep = body.length - 1; keep >= 0; keep--) {
    const note = `   … ${body.length - keep}줄 생략 — 전체는 헬스체크 /preview`;
    const text = join([...head, ...body.slice(0, keep), note, ...tail]);
    if (slackBytes(text) <= limitBytes) return text;
  }
  return boundedSlackText(whole, limitBytes);
}

// The card line for a failing project. The full detail repeats the same
// two-sentence diagnosis for each of two attempts; with five tabs down that
// alone was over Slack's limit. The card says what it is and how long the
// probe took — the full text stays in /preview and the state file.
export function cardDetail(detail) {
  const text = String(detail ?? '');
  if (!isLinkDownDetail(text)) return shortText(detailSummary(text), 120);
  const streak = text.match(/(\d+)회 연속 실패/);
  const link = text.match(/link (\d+)ms/);
  return [streak ? `${streak[1]}회 연속` : null, '문서 서버 연결 끊김(Figma API 연결 오류)',
    link ? `link ${(Number(link[1]) / 1000).toFixed(1)}s` : null].filter(Boolean).join(' · ');
}

export const replaceableSlackMessage = (result) =>
  result?.ok === false && result?.error === 'message_not_found';

// Same timestamp on a length rejection. Never turn a bad payload into a new
// channel message, and never retry an ambiguous network outcome as a new post.
export async function deliverSlack(method, body, send) {
  const bounded = typeof body.text === 'string'
    ? {...body, text: boundedSlackText(body.text)} : body;
  const result = await send(method, bounded);
  if (result?.error !== 'msg_too_long' || typeof bounded.text !== 'string') return result;
  return send(method, {...bounded, text: boundedSlackText(bounded.text, SLACK_RETRY_MAX_BYTES)});
}

// One stalled Slack must cost a tick one timeout, not one per call. A tick
// makes up to nine Slack calls (card, its retry, thread changes, speed reply,
// outlier), each bounded at 15s; on a flapping connection (ECONNRESET, timeouts
// — both in health.log) they all paid in turn. After the first transient
// failure the rest of the tick is skipped as transient too, so every caller
// keeps its "retry next round" path, and the next tick starts fresh.
export function tickScopedSlack(send) {
  let tripped = null;
  return {
    reset() { tripped = null; },
    get tripped() { return tripped; },
    async send(method, body) {
      if (tripped) return {ok: false, error: `skipped — Slack already failed this tick (${tripped})`, transient: true, skipped: true};
      const result = await send(method, body);
      if (result?.transient) tripped = String(result.error || 'transient');
      return result;
    },
  };
}

// --- link-down recovery ------------------------------------------------------
// A plugin that is connected to a tab whose document lost Figma's servers
// passes every check but the link probe, and re-running the plugin does not
// fix it — the tab has to be reloaded from the server. From 2026-10-30 20:07
// all eight product tabs on macmini-1 sat like that for 38 hours, and this card
// only ever offered "플러그인 재연결". These decide when to say what actually
// recovers it, and (opt-in) when to run that recovery once.
//
// Only Figma's own connection error counts. A slow lookup is "응답 지연" —
// inconclusive — and must not send anyone to reload a tab.
export const LINK_REPAIR_AFTER_MS = 15 * 60_000;
export const isLinkDownDetail = (detail) => /문서 서버 조회 실패/.test(String(detail ?? ''));

// Per-project clocks of when the link was first seen down, carried across
// ticks. A project leaves the map the moment its last verdict is anything else.
export function trackLinkDown(previous, deepResults, now) {
  const next = {};
  for (const [key, result] of Object.entries(deepResults || {})) {
    if (result?.ok === false && isLinkDownDetail(result.detail)) {
      next[key] = previous?.[key] ?? result.at ?? now;
    }
  }
  return next;
}

// Which link-down projects have been down long enough to act on, split by
// whether anyone's requests are on them (never reload under a caller).
export function linkRepairPlan(linkDownSince, loadByKey, now, afterMs = LINK_REPAIR_AFTER_MS) {
  const ready = [], busy = [], waiting = [];
  let since = null;
  for (const [key, at] of Object.entries(linkDownSince || {})) {
    since = since == null ? at : Math.min(since, at);
    if (now - at < afterMs) waiting.push(key);
    else if ((loadByKey?.[key] || 0) > 0) busy.push(key);
    else ready.push(key);
  }
  return { ready, busy, waiting, since };
}

export function linkRepairLine(plan, name = (key) => key) {
  if (!plan.ready.length && !plan.busy.length) return null;
  const parts = [
    '• 복구 액션(문서 서버 연결 끊김 — 플러그인 재실행으로는 안 고쳐짐): 브로커 액션 `figma-open-projects` (macmini-1)',
    '  런처가 끊긴 탭만 「Save and reload」 배너(있으면) 또는 탭 닫기→다시 열기로 서버에서 다시 불러오고 플러그인을 재부착합니다. 다른 창은 건드리지 않고, 미저장 변경 대화상자가 뜨면 중단합니다.',
  ];
  if (plan.ready.length) parts.push(`  대상: ${plan.ready.map(name).join(', ')}`);
  if (plan.busy.length) parts.push(`  작업 중이라 보류: ${plan.busy.map(name).join(', ')}`);
  parts.push('  먼저 읽기 전용으로 확인: `run.sh --link-check` · macmini-1 화면이 잠겨 있으면 콘솔 잠금 해제가 먼저입니다(잠긴 동안은 창을 조작할 수 없음).');
  return parts.join('\n');
}

// The automatic run. On by default wherever the launcher is installed
// (resolveLinkRepairCmd) — the opt-in left 6/9 tabs link-down for 16 hours on
// 2026-11-07..08 while the one command that fixed 8 of them in a minute sat
// unused.
//
// First run as soon as something is ready in a new incident. After that, retry
// while the incident lasts instead of giving up after one shot: the outages
// this exists for outlast a single attempt — 11-05 was 15 hours behind a locked
// screen, where any run before the unlock can only fail — and a run that met
// another launcher's lock (exit 75) did nothing at all. Hourly is far below
// the launcher's own cost (it touches only idle link-down tabs and stops on an
// unsaved-changes prompt) and far above how long one run takes; exit 75 means
// "someone else is on it", so look again sooner.
export const LINK_REPAIR_RETRY_MS = 60 * 60_000;
export const LINK_REPAIR_BUSY_RETRY_MS = 10 * 60_000;
// The decision itself is shouldTriggerRepair, further down: the same launcher
// run also serves projects whose plugin is missing, so there is one clock.

// HEALTH_LINK_REPAIR_CMD wins when set — "" / off / 0 / false switch it off on
// purpose. Unset means the device's launcher if it is installed, nothing if not.
export const DEFAULT_LINK_REPAIR_SUFFIX = '/.codex/skills/figma-product-mcp/scripts/run-broker.sh';
export function resolveLinkRepairCmd(env, home, exists) {
  if (env && Object.prototype.hasOwnProperty.call(env, 'HEALTH_LINK_REPAIR_CMD')) {
    const value = String(env.HEALTH_LINK_REPAIR_CMD ?? '').trim();
    return /^(off|0|false|no)?$/i.test(value) ? '' : value;
  }
  const path = `${home}${DEFAULT_LINK_REPAIR_SUFFIX}`;
  return exists(path) ? path : '';
}

// --- plugin-missing recovery -------------------------------------------------
// The link repair above only ever looked at documents that lost Figma's
// servers. On 2026-11-10 19:35 KST every user process on macmini-1 took a
// SIGTERM; launchd brought the relay and this watcher straight back, but Figma
// was left as a main process with no renderers — nine project windows without
// a plugin among them. Nothing was link-down (there was no plugin to ask), so
// the repair never ran: one attempt at 18:33 for an earlier link failure, then
// 14 hours 46 minutes of connections.figma=0 until someone ran the launcher by
// hand. A plugin that stays missing is the launcher's job just as much.
//
// Ten minutes, not the two polls that confirm a drop: a Figma update, a person
// reloading a tab, or the relay restarting all clear by themselves well inside
// that, and the launcher drives real windows.
export const PLUGIN_REPAIR_AFTER_MS = 10 * 60_000;

// downSince: expected title -> when its plugin was confirmed missing. With the
// relay down nothing is "ready": the launcher cannot verify a connection
// without it, and the card already says the relay is the problem.
export function pluginRepairPlan(downSince, now, afterMs = PLUGIN_REPAIR_AFTER_MS, relayUp = true) {
  const ready = [], waiting = [];
  let since = null;
  for (const [name, at] of Object.entries(downSince || {})) {
    since = since == null ? at : Math.min(since, at);
    (relayUp && now - at >= afterMs ? ready : waiting).push(name);
  }
  return { ready, waiting, since, readyAt: since == null ? null : since + afterMs };
}

// What a finished launcher run said, reduced to what the card and the retry
// clock need. stdout is the launcher's JSON report (run.sh prints nothing
// else); anything unparseable still yields the exit code.
//
// `blocked` names a reason no retry can get past by itself, so the card can say
// who has to do what instead of "exit 1".
export function repairOutcome(code, stdout) {
  let report = null;
  const text = String(stdout ?? '');
  const from = text.indexOf('{'), to = text.lastIndexOf('}');
  if (from >= 0 && to > from) {
    try { report = JSON.parse(text.slice(from, to + 1)); } catch { report = null; }
  }
  const results = Array.isArray(report?.results) ? report.results : [];
  const failed = results.filter((entry) => entry?.status !== 'connected')
    .map((entry) => ({ title: String(entry?.title ?? entry?.id ?? '?'), status: String(entry?.status ?? '?'), step: entry?.step ? String(entry.step) : null }));
  const details = results.map((entry) => String(entry?.detail ?? '')).join(' ');
  let blocked = null;
  if (code === 75 || failed.some((entry) => entry.status === 'repair_in_progress')) blocked = 'repair_in_progress';
  else if (failed.some((entry) => entry.status === 'screen_locked')) blocked = 'screen_locked';
  else if (failed.some((entry) => entry.status === 'relay_unreachable')) blocked = 'relay_unreachable';
  else if (failed.some((entry) => entry.status === 'launcher_failed') && /accessibility/i.test(details)) blocked = 'accessibility';
  else if (failed.some((entry) => entry.status === 'launcher_failed')) blocked = 'launcher_error';
  else if (code !== 0 && !results.length) blocked = 'no_report';
  return {
    code, blocked,
    total: results.length,
    connected: results.length - failed.length,
    failed: failed.slice(0, 12),
  };
}

const BLOCKED_TEXT = {
  repair_in_progress: '다른 복구가 이미 진행 중이라 이번 실행은 아무것도 하지 않음 (exit 75 — 실패 아님)',
  screen_locked: ':lock: macmini-1 화면이 잠겨 있어 복구 불가 — 콘솔(또는 화면 공유)에서 잠금을 풀어야 합니다. 잠긴 동안 런처는 창을 건드리지 않으며, 풀리면 다음 재시도에서 복구됩니다',
  relay_unreachable: '런처가 릴레이(3055)에 닿지 못해 아무것도 열지 않음 — 릴레이·호스트 부하 확인 필요',
  accessibility: '런처에 손쉬운 사용(Accessibility) 권한이 없어 Figma 창을 조작할 수 없음 — macmini-1 시스템 설정에서 허용 필요',
  launcher_error: '런처가 실행 중 오류로 끝남 — 로그 ~/.talk-to-figma/link-repair.log',
  no_report: '런처가 리포트 없이 끝남(빌드 실패·강제 종료 가능) — 로그 ~/.talk-to-figma/link-repair.log',
};

export function repairOutcomeLine(outcome) {
  if (!outcome) return null;
  if (outcome.blocked && BLOCKED_TEXT[outcome.blocked]) return BLOCKED_TEXT[outcome.blocked];
  if (!outcome.failed?.length) return outcome.total ? `${outcome.connected}/${outcome.total} 연결 확인` : `exit ${outcome.code}`;
  const shown = outcome.failed.slice(0, 4)
    .map((entry) => `${entry.title}(${entry.step ? `${entry.status}/${entry.step}` : entry.status})`);
  const more = outcome.failed.length > shown.length ? ` 외 ${outcome.failed.length - shown.length}` : '';
  return `연결 ${outcome.connected}/${outcome.total} · 실패: ${shown.join(', ')}${more}`;
}

// How long to wait before running the launcher again inside one incident.
//
// - Another run holds the lock (75) or the screen is locked: nothing was
//   touched and nothing can be until that clears, so look again soon — the
//   locked launcher reads one flag and exits.
// - A run that failed with plugins still missing: back off 10 → 20 → 40 min up
//   to the hourly ceiling. One slow file load (connect_timeout) must not cost
//   an hour of a total outage, and a launcher that cannot fix it must not keep
//   driving windows every ten minutes either.
// - Link-down only keeps the hourly cadence it had: that repair closes and
//   reopens tabs.
export function repairRetryDelay({ result, triggeredAt, attempts = 1, pluginReady = false,
  retryMs = LINK_REPAIR_RETRY_MS, busyRetryMs = LINK_REPAIR_BUSY_RETRY_MS }) {
  const finished = result && result.at >= triggeredAt;
  // No result and (the caller checked) nothing running: the run was lost — the
  // watcher itself was restarted under it, as on 11-10 19:35 — or has been
  // going for half an hour. With plugins missing, ask again soon: the lock
  // answers a second run with 75 if the first is still alive. Link-down alone
  // keeps its hourly clock.
  if (!finished) return pluginReady ? busyRetryMs : retryMs;
  if (result.code === 75 || result.blocked === 'repair_in_progress' || result.blocked === 'screen_locked') return busyRetryMs;
  if (pluginReady && result.code !== 0) {
    return Math.min(retryMs, busyRetryMs * 2 ** Math.max(0, attempts - 1));
  }
  return retryMs;
}

// One launcher run serves both causes (it reopens what is missing and reloads
// what is link-down), so there is one decision and one clock.
//
// First run of an incident: at once. Later: on the retry clock — except when
// something became ready that broke AFTER the last run started. That run
// cannot have fixed it, and making it wait out a clock set by an unrelated
// earlier attempt is the 11-10 outage in miniature (18:33 link repair, 19:36
// everything gone).
export function shouldTriggerRepair({ linkPlan, pluginPlan, linkDownSince = {}, downSince = {}, configured,
  running = false, triggeredAt = 0, incidentSince = 0, result = null, attempts = 1, now = Date.now(),
  retryMs = LINK_REPAIR_RETRY_MS, busyRetryMs = LINK_REPAIR_BUSY_RETRY_MS }) {
  const linkReady = linkPlan?.ready || [], pluginReady = pluginPlan?.ready || [];
  if (!configured || running || !(linkReady.length + pluginReady.length)) return false;
  if (!(triggeredAt && triggeredAt >= incidentSince)) return true;
  const brokeSince = pluginReady.some((name) => (downSince[name] || 0) > triggeredAt)
    || linkReady.some((key) => (linkDownSince[key] || 0) > triggeredAt);
  if (brokeSince) return true;
  return now - triggeredAt >= repairRetryDelay({ result, triggeredAt, attempts, pluginReady: pluginReady.length > 0, retryMs, busyRetryMs });
}

export function nextRepairAt({ triggeredAt, result, attempts = 1, pluginReady = false,
  retryMs = LINK_REPAIR_RETRY_MS, busyRetryMs = LINK_REPAIR_BUSY_RETRY_MS }) {
  if (!triggeredAt) return null;
  return triggeredAt + repairRetryDelay({ result, triggeredAt, attempts, pluginReady, retryMs, busyRetryMs });
}

// --- telling someone again ---------------------------------------------------
// An edit does not notify. The 19:36 total outage on 2026-11-10 landed as an
// edit to the 18:08 card (one project's deep check) plus thread replies, so the
// channel showed nothing new and nobody looked for 14 hours. Two things now
// earn a NEW top-level message inside a running incident:
//
//   total_outage    — it got categorically worse: no required project has a
//                     plugin (or the relay is gone), held for a few polls so a
//                     relay restart does not page anyone.
//   still_degraded  — it has gone unanswered: an hour since the last alert.
//                     After the first reminder an unchanged picture repeats
//                     only every six hours; a changed one (other projects, the
//                     relay) is news again after an hour.
export const REALERT_AFTER_MS = 60 * 60_000;
export const REALERT_UNCHANGED_MS = 6 * 60 * 60_000;
export const TOTAL_OUTAGE_CONFIRM_MS = 3 * 60_000;

export const isTotalOutage = (health) => (health?.expected?.length || 0) > 0
  && (!health.relayUp || (health.missing?.length || 0) >= health.expected.length);

// What the alert was about, for "is this the same thing I already said".
export function alertSignature(health) {
  return JSON.stringify([Boolean(health?.relayUp), [...(health?.missing || [])].sort(), [...(health?.failingDeep || [])].sort()]);
}

export function realertDecision({ totalSince = 0, totalAlerted = false, lastAlertAt = 0, lastSignature = '', signature = '',
  reminders = 0, now = Date.now(), afterMs = REALERT_AFTER_MS, unchangedMs = REALERT_UNCHANGED_MS,
  confirmMs = TOTAL_OUTAGE_CONFIRM_MS }) {
  if (totalSince && !totalAlerted && now - totalSince >= confirmMs) return 'total_outage';
  if (!lastAlertAt || now - lastAlertAt < afterMs) return null;
  if (reminders === 0 || signature !== lastSignature || now - lastAlertAt >= unchangedMs) return 'still_degraded';
  return null;
}
