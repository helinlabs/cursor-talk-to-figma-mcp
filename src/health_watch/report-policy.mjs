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

export function boundedSlackText(text, limit = 3500) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= limit) return chars.join('');
  const suffix = '\n… 상세 결과는 헬스체크 /preview에서 확인하세요.';
  const head = chars.slice(0, limit - Array.from(suffix).length).join('');
  // Do not cut a Slack URL/mention halfway through.
  const lineEnd = head.lastIndexOf('\n');
  return (lineEnd > 0 ? head.slice(0, lineEnd) : shortText(head, head.length)) + suffix;
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
  return send(method, {...bounded, text: boundedSlackText(bounded.text, 1500)});
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

// Opt-in automatic run: once per incident, and only when something is ready.
export function shouldTriggerLinkRepair(plan, { configured, triggeredAt, incidentSince }) {
  if (!configured || !plan.ready.length) return false;
  return !(triggeredAt && triggeredAt >= incidentSince);
}
