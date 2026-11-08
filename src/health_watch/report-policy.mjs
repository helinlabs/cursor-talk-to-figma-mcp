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
export function shouldTriggerLinkRepair(plan, { configured, triggeredAt, incidentSince, running = false,
  result = null, now = Date.now(), retryMs = LINK_REPAIR_RETRY_MS, busyRetryMs = LINK_REPAIR_BUSY_RETRY_MS }) {
  if (!configured || !plan.ready.length || running) return false;
  if (!(triggeredAt && triggeredAt >= incidentSince)) return true;
  const lockedOut = result && result.at >= triggeredAt && result.code === 75;
  return now - triggeredAt >= (lockedOut ? busyRetryMs : retryMs);
}

export function nextLinkRepairAt({ triggeredAt, result, retryMs = LINK_REPAIR_RETRY_MS, busyRetryMs = LINK_REPAIR_BUSY_RETRY_MS }) {
  if (!triggeredAt) return null;
  const lockedOut = result && result.at >= triggeredAt && result.code === 75;
  return triggeredAt + (lockedOut ? busyRetryMs : retryMs);
}

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
