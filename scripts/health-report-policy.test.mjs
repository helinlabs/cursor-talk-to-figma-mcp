import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {LINK_TIMEOUT_MS, linkFailureDetail, detailSummary, boundedSlackText,
  replaceableSlackMessage, deliverSlack} from '../src/health_watch/report-policy.mjs';

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
assert.ok(Array.from(sent[0].text).length<=3500);
assert.ok(Array.from(sent[1].text).length<=1500);
let attempts=0;
await deliverSlack('chat.update',{ts:'123',text:long},async()=>{attempts++;return {ok:false,transient:true}});
assert.equal(attempts,1);

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
