import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {LINK_TIMEOUT_MS, linkFailureDetail, detailSummary, boundedSlackText,
  replaceableSlackMessage, deliverSlack, slackBytes, SLACK_TEXT_MAX_BYTES, SLACK_RETRY_MAX_BYTES,
  fitSlackCard, cardDetail, tickScopedSlack} from '../src/health_watch/report-policy.mjs';

assert.match(linkFailureDetail({error:'no answer in 15000ms'}), /단절 여부 미확인/);
assert.match(linkFailureDetail({error:'Unable to establish connection to Figma after 10 seconds'}), /API가 연결 오류/);
assert.doesNotMatch(linkFailureDetail({error:'no answer in 3000ms'}), /목록은 빠진|10초 뒤/);
const legacy = '2회 연속 실패 — 문서가 피그마 서버와 끊겨 있습니다 — 없는 노드 ID 조회가 3.9s 동안 답이 없음(no answer in 3000ms). 이 탭의 목록은 빠진 채로 나오고 노드 조회는 10초 뒤 "Unable to establish connection" 으로 실패합니다.';
assert.match(detailSummary(legacy), /미확인/);
assert.doesNotMatch(detailSummary(legacy), /목록은 빠진/);
assert.ok(detailSummary('x'.repeat(50000)).length <= 180);
const long = Array.from({length:8},(_,i)=>`파일${i} ${legacy.repeat(100)}`).join('\n');
for (const limit of [1500,3500]) assert.ok(Array.from(boundedSlackText(long,limit)).length <= limit);
assert.equal(boundedSlackText('정상 😀'), '정상 😀');
assert.equal(replaceableSlackMessage({ok:false,error:'message_not_found'}),true);
for(const error of ['msg_too_long','invalid_auth','cant_update_message','ratelimited'])
 assert.equal(replaceableSlackMessage({ok:false,error}),false);

const sent=[];
await deliverSlack('chat.update',{ts:'123.456',text:long},async(method,body)=>{
 sent.push({method,...body});return sent.length===1?{ok:false,error:'msg_too_long'}:{ok:true};
});
assert.equal(sent.length,2);
assert.ok(sent.every(x=>x.method==='chat.update' && x.ts==='123.456'));
assert.ok(slackBytes(sent[0].text)<=SLACK_TEXT_MAX_BYTES);
assert.ok(slackBytes(sent[1].text)<=SLACK_RETRY_MAX_BYTES);
let attempts=0;
await deliverSlack('chat.update',{ts:'123',text:long},async()=>{attempts++;return {ok:false,transient:true}});
assert.equal(attempts,1);

// --- Slack's limit is bytes -------------------------------------------------
// chat.update rejected 4,008 bytes and took 3,990 (2026-11-08, #dev_noti_figma).
// The degraded card that hit msg_too_long 10,517 times was 2,400 characters of
// mostly hangul — 4,205 bytes — so a character bound let it straight through.
assert.ok(SLACK_TEXT_MAX_BYTES < 4000);
assert.equal(slackBytes('가'), 3);
assert.equal(slackBytes('😀'), 4);
const hangulCard = Array.from({length: 40}, (_, i) => `• ${i}번 줄 — 문서 서버 조회 실패 — Figma API가 연결 오류를 반환함 · 플러그인 연결`).join('\n');
assert.ok(Array.from(hangulCard).length < 3500 && slackBytes(hangulCard) > 4000, 'fixture must be under the old char bound but over the byte limit');
const cut = boundedSlackText(hangulCard);
assert.ok(slackBytes(cut) <= SLACK_TEXT_MAX_BYTES);
assert.match(cut, /\/preview/);
assert.ok(!cut.includes('\uFFFD'));
// Code points are never split, even with no line break to cut at.
for (const unit of ['가', '😀', 'x']) {
  const out = boundedSlackText(unit.repeat(5000), 1000);
  assert.ok(slackBytes(out) <= 1000);
  assert.ok(!out.includes('\uFFFD'));
}

// The card keeps its head and tail (repair action, console link) and gives up
// project lines instead, saying how many.
const head = [':red_circle: *Figma 헬스체크 · 이상 감지*', '• 프로젝트별 상태:'];
const body = Array.from({length: 30}, (_, i) => `   :red_circle: P${i}_Product — 플러그인 연결 · 유휴 · ${'문서 서버 연결 끊김 '.repeat(4)}`);
const tail = ['• 복구 액션: 브로커 액션 `figma-open-projects`', ':link: <https://example.test/|웹 릴레이 콘솔 열기>'];
const card = fitSlackCard({head, body, tail});
assert.ok(slackBytes(card) <= SLACK_TEXT_MAX_BYTES);
assert.ok(card.startsWith(head[0]));
assert.ok(card.endsWith(tail[1]));
assert.match(card, /figma-open-projects/);
const omitted = Number(card.match(/… (\d+)줄 생략/)[1]);
assert.equal(card.split('\n').filter((line) => line.includes('_Product —')).length, body.length - omitted);
// Small cards are left exactly as they are.
assert.equal(fitSlackCard({head: ['a'], body: ['b'], tail: ['c']}), 'a\nb\nc');

// The per-project line for a link-down tab is short and still says what it is.
const doubleDown = `2회 연속 실패 — 1차: ${linkFailureDetail({error: 'Unable to establish connection to Figma after 10 seconds'})} · pages 194ms · link 11328ms · 2차: ${linkFailureDetail({error: 'Unable to establish connection to Figma after 10 seconds'})} · pages 200ms · link 11002ms`;
assert.equal(cardDetail(doubleDown), '2회 연속 · 문서 서버 연결 끊김(Figma API 연결 오류) · link 11.3s');
assert.ok(Array.from(cardDetail('x'.repeat(5000))).length <= 120);
assert.match(cardDetail(`2회 연속 실패 — 1차: ${linkFailureDetail({error: 'no answer in 15000ms'})}`), /응답 지연/);
// Five link-down tabs, as on 2026-11-08, now fit with room to spare.
const fiveDown = Array.from({length: 9}, (_, i) => `   :red_circle: Project${i} — 플러그인 연결 · 유휴 · 심층 점검 미통과 (34분 전) — ${cardDetail(doubleDown)}`).join('\n');
assert.ok(slackBytes(fiveDown) < 2000);

// One transient Slack failure skips the rest of the tick instead of paying a
// timeout per call; the next tick starts fresh. Definitive answers do not trip it.
const calls = [];
const gate = tickScopedSlack(async (method) => {
  calls.push(method);
  return method === 'chat.update' ? {ok: false, error: 'timed out after 15000ms', transient: true} : {ok: true, ts: '1'};
});
assert.equal((await gate.send('chat.update', {})).transient, true);
const skipped = await gate.send('chat.postMessage', {});
assert.equal(skipped.ok, false);
assert.equal(skipped.transient, true);   // callers keep their retry-next-round path
assert.equal(replaceableSlackMessage(skipped), false);   // and never post a duplicate card
assert.deepEqual(calls, ['chat.update']);
gate.reset();
assert.equal((await gate.send('chat.postMessage', {})).ok, true);
assert.deepEqual(calls, ['chat.update', 'chat.postMessage']);
const definitive = tickScopedSlack(async () => ({ok: false, error: 'msg_too_long'}));
await definitive.send('chat.update', {});
assert.equal(definitive.tripped, null);
// deliverSlack's msg_too_long retry goes through the gate unharmed.
let gated = 0;
const retryGate = tickScopedSlack(async () => (++gated === 1 ? {ok: false, error: 'msg_too_long'} : {ok: true}));
assert.equal((await deliverSlack('chat.update', {ts: '1', text: hangulCard}, retryGate.send)).ok, true);
assert.equal(gated, 2);

// Exercise the actual existing plugin probe with a deterministic clock: a
// server response at 4s used to fail at 3s; the watcher now allows it to answer.
const source=readFileSync(new URL('../src/cursor_mcp_plugin/code.js',import.meta.url),'utf8');
const probe=source.slice(source.indexOf('const LINK_PROBE_ID'),source.indexOf('const SERVER_LOOKUP_FAILED'));
async function probeAt(responseMs,params,error) {
 const jobs=[];let now=0;
 const ctx={Date:{now:()=>now},describeCommandError:e=>e.message,
 setTimeout:(fn,ms)=>{const job={fn,at:now+ms};jobs.push(job);return job;},
 clearTimeout:job=>{if(job)job.cancelled=true},
 figma:{getNodeByIdAsync:()=>new Promise((resolve,reject)=>jobs.push({at:responseMs,fn:()=>error?reject(new Error(error)):resolve(null)}))}};
 const run=runInNewContext(probe+'\ngetDocumentLinkStatus',ctx);
 const pending=run(params);
 jobs.sort((a,b)=>a.at-b.at);
 for(const job of jobs){if(!job.cancelled){now=job.at;job.fn();await Promise.resolve();await Promise.resolve();await Promise.resolve();}}
 return pending;
}
assert.equal((await probeAt(4000,{})).ok,false);
assert.equal((await probeAt(4000,{timeoutMs:LINK_TIMEOUT_MS})).ok,true);
const failed=await probeAt(10000,{timeoutMs:LINK_TIMEOUT_MS},'Unable to establish connection to Figma after 10 seconds');
assert.equal(failed.ok,false);
assert.match(linkFailureDetail(failed),/API가 연결 오류/);
assert.match(linkFailureDetail(await probeAt(20000,{timeoutMs:LINK_TIMEOUT_MS})),/미확인/);
const watcher=readFileSync(new URL('../src/health_watch/watch.ts',import.meta.url),'utf8');
assert.match(watcher,/get_document_link_status", \{ timeoutMs: LINK_TIMEOUT_MS \}/);
console.log('health report policy: all regressions passed');
