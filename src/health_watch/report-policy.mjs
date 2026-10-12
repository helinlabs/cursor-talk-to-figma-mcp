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
