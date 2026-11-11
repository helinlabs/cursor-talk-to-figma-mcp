// The watcher's answer to "every plugin is gone", replayed against the outage
// that had none.
//
// macmini-1, 2026-11-10 (KST). 18:08 one project's deep check fails and the
// incident card opens. 18:33 the link repair runs once (exit 0). 19:35:40 every
// user process takes a SIGTERM; the watcher is back at 19:35:42, Figma is left
// without renderers, and from 19:36:42 all nine required projects are
// "플러그인 없음". Until 11-11 10:22 — 14h46m — the watcher edited the 18:08 card
// once a minute and did nothing else: the repair only knew link-down, and an
// edit notifies nobody.
import assert from 'node:assert/strict';
import {
  PLUGIN_REPAIR_AFTER_MS, pluginRepairPlan, linkRepairPlan, shouldTriggerRepair, nextRepairAt, repairRetryDelay,
  repairOutcome, repairOutcomeLine, LINK_REPAIR_RETRY_MS, LINK_REPAIR_BUSY_RETRY_MS,
  REALERT_AFTER_MS, REALERT_UNCHANGED_MS, TOTAL_OUTAGE_CONFIRM_MS, isTotalOutage, alertSignature, realertDecision,
  fitSlackCard, slackBytes, SLACK_TEXT_MAX_BYTES,
} from '../src/health_watch/report-policy.mjs';

const kst = (text) => Date.parse(`${text}+09:00`);
const names = ['T_Product', 'CA_Product', 'GW_Product', 'GW_ASO', 'GW_Apple Watch', 'CO_Product', 'D_Product', 'F_Product', 'Enfit'];
const incidentSince = kst('2026-11-10T18:08:58');
const linkRan = kst('2026-11-10T18:33:21');
const linkResult = {at: kst('2026-11-10T18:34:20'), code: 0};
const allDown = kst('2026-11-10T19:36:42');
const downSince = Object.fromEntries(names.map((name) => [name, allDown]));
const noLink = linkRepairPlan({}, {}, allDown);

// --- when the launcher is sent ----------------------------------------------
assert.equal(PLUGIN_REPAIR_AFTER_MS, 10 * 60_000);
// Not before the hold time: a Figma update or a reloaded tab comes back by itself.
let plan = pluginRepairPlan(downSince, allDown + PLUGIN_REPAIR_AFTER_MS - 1);
assert.deepEqual(plan.ready, []);
assert.equal(plan.waiting.length, 9);
assert.equal(plan.readyAt, allDown + PLUGIN_REPAIR_AFTER_MS);
// At ten minutes all nine are the launcher's job.
const at1946 = allDown + PLUGIN_REPAIR_AFTER_MS;
plan = pluginRepairPlan(downSince, at1946);
assert.deepEqual(plan.ready, names);
// With the relay down the launcher could not verify anything: nothing is ready.
assert.deepEqual(pluginRepairPlan(downSince, at1946, PLUGIN_REPAIR_AFTER_MS, false).ready, []);
assert.deepEqual(pluginRepairPlan({}, at1946), {ready: [], waiting: [], since: null, readyAt: null});

const base = {linkPlan: noLink, pluginPlan: plan, downSince, configured: true, incidentSince};
// THE outage: the incident already had a run (18:33, exit 0, for a link
// failure). The nine plugins broke after it — that run cannot have fixed them,
// so this goes at 19:46, not whenever an unrelated clock allows.
assert.equal(shouldTriggerRepair({...base, triggeredAt: linkRan, result: linkResult, now: at1946}), true);
// The old decision only ever saw link-down: with none, it never ran. That is the bug.
assert.equal(shouldTriggerRepair({...base, pluginPlan: pluginRepairPlan({}, at1946), triggeredAt: linkRan, result: linkResult, now: at1946}), false);
// Not configured, already running, or nothing ready: no run.
assert.equal(shouldTriggerRepair({...base, configured: false, now: at1946}), false);
assert.equal(shouldTriggerRepair({...base, running: true, now: at1946}), false);
assert.equal(shouldTriggerRepair({...base, pluginPlan: pluginRepairPlan(downSince, at1946 - 1), now: at1946 - 1}), false);
// A fresh incident's first run goes at once.
assert.equal(shouldTriggerRepair({...base, triggeredAt: 0, now: at1946}), true);

// --- and sent again while it stays broken -----------------------------------
const ran = at1946;
const after = (extra) => ({...base, triggeredAt: ran, ...extra});
const failed = {at: ran + 240_000, code: 1, blocked: null};
// A failed run backs off 10 → 20 → 40 → 60 min; never an hour after one miss.
assert.equal(repairRetryDelay({result: failed, triggeredAt: ran, attempts: 1, pluginReady: true}), 10 * 60_000);
assert.equal(repairRetryDelay({result: failed, triggeredAt: ran, attempts: 2, pluginReady: true}), 20 * 60_000);
assert.equal(repairRetryDelay({result: failed, triggeredAt: ran, attempts: 3, pluginReady: true}), 40 * 60_000);
assert.equal(repairRetryDelay({result: failed, triggeredAt: ran, attempts: 4, pluginReady: true}), LINK_REPAIR_RETRY_MS);
assert.equal(repairRetryDelay({result: failed, triggeredAt: ran, attempts: 9, pluginReady: true}), LINK_REPAIR_RETRY_MS);
assert.equal(shouldTriggerRepair(after({result: failed, attempts: 1, now: ran + 10 * 60_000 - 1})), false);
assert.equal(shouldTriggerRepair(after({result: failed, attempts: 1, now: ran + 10 * 60_000})), true);
assert.equal(shouldTriggerRepair(after({result: failed, attempts: 2, now: ran + 10 * 60_000})), false);
// Link-down alone keeps its hourly cadence (that repair closes tabs).
assert.equal(repairRetryDelay({result: failed, triggeredAt: ran, attempts: 1, pluginReady: false}), LINK_REPAIR_RETRY_MS);
// exit 75 is a guard, not a failure: nothing ran, look again in ten minutes — and no sooner.
const guarded = {at: ran + 25_000, code: 75, blocked: 'repair_in_progress'};
assert.equal(shouldTriggerRepair(after({result: guarded, attempts: 5, now: ran + LINK_REPAIR_BUSY_RETRY_MS - 1})), false);
assert.equal(shouldTriggerRepair(after({result: guarded, attempts: 5, now: ran + LINK_REPAIR_BUSY_RETRY_MS})), true);
// A locked screen: the launcher touched nothing and cannot until someone
// unlocks it. Keep asking every ten minutes so the unlock is picked up.
const lockedOut = {at: ran + 2_000, code: 1, blocked: 'screen_locked'};
assert.equal(repairRetryDelay({result: lockedOut, triggeredAt: ran, attempts: 7, pluginReady: true}), LINK_REPAIR_BUSY_RETRY_MS);
// The watcher was restarted under its own run (19:35 again): no result ever
// lands. With plugins missing that is ten minutes, not an hour.
assert.equal(shouldTriggerRepair(after({result: null, now: ran + LINK_REPAIR_BUSY_RETRY_MS})), true);
assert.equal(shouldTriggerRepair(after({result: null, now: ran + LINK_REPAIR_BUSY_RETRY_MS - 1})), false);
// A run that said everything connected waits the full hour before doubting itself.
assert.equal(repairRetryDelay({result: {at: ran + 1, code: 0}, triggeredAt: ran, attempts: 1, pluginReady: true}), LINK_REPAIR_RETRY_MS);
assert.equal(nextRepairAt({triggeredAt: ran, result: lockedOut, attempts: 3, pluginReady: true}), ran + LINK_REPAIR_BUSY_RETRY_MS);
assert.equal(nextRepairAt({triggeredAt: 0}), null);
// Something that broke after the last run started does not wait for its clock…
const later = {...downSince, Enfit: ran + 60_000};
assert.equal(shouldTriggerRepair({...base, downSince: later, pluginPlan: pluginRepairPlan(later, ran + 60_000 + PLUGIN_REPAIR_AFTER_MS),
  triggeredAt: ran, result: {at: ran + 30_000, code: 0}, now: ran + 60_000 + PLUGIN_REPAIR_AFTER_MS}), true);
// …but that can never be more often than the hold time, and not under a live run.
assert.equal(shouldTriggerRepair({...base, downSince: later, pluginPlan: pluginRepairPlan(later, ran + 60_000 + PLUGIN_REPAIR_AFTER_MS),
  triggeredAt: ran, running: true, now: ran + 60_000 + PLUGIN_REPAIR_AFTER_MS}), false);

// --- what the launcher said --------------------------------------------------
const entry = (title, status, step, detail = '') => ({id: title.toLowerCase(), title, status, step, detail, url: ''});
const report = (results, extra = {}) => JSON.stringify({ok: results.every((r) => r.status === 'connected'), dryRun: false, results, ...extra}, null, 2);
// The 11-11 10:22 run, as the fallback session read it: nine separation_failed.
const primary = repairOutcome(1, report(names.map((name) => entry(name, 'separation_failed', 'renderer_accessibility'))));
assert.equal(primary.blocked, null);
assert.equal(primary.connected, 0);
assert.equal(primary.total, 9);
assert.match(repairOutcomeLine(primary), /연결 0\/9 · 실패: T_Product\(separation_failed\/renderer_accessibility\).* 외 5/);
// A locked console is named as the blocker, with who has to act.
const lockedReport = repairOutcome(1, report([entry('T_Product', 'connected'), ...names.slice(1).map((name) => entry(name, 'screen_locked', 'screen_locked'))]));
assert.equal(lockedReport.blocked, 'screen_locked');
assert.equal(lockedReport.connected, 1);
assert.match(repairOutcomeLine(lockedReport), /화면이 잠겨 있어 복구 불가/);
assert.match(repairOutcomeLine(lockedReport), /잠금을 풀어야/);
// exit 75, with the launcher's stderr line in front of the JSON.
const busy = repairOutcome(75, 'another launcher run is still repairing; not starting a second one\n'
  + report(names.map((name) => entry(name, 'repair_in_progress', null))));
assert.equal(busy.blocked, 'repair_in_progress');
assert.match(repairOutcomeLine(busy), /exit 75 — 실패 아님/);
assert.equal(repairOutcome(2, report([entry('launcher', 'launcher_failed', null, 'macOS Accessibility access is required')])).blocked, 'accessibility');
assert.equal(repairOutcome(2, report([entry('launcher', 'launcher_failed', null, '--config is required')])).blocked, 'launcher_error');
assert.equal(repairOutcome(1, report(names.map((name) => entry(name, 'relay_unreachable', 'relay_unreachable')))).blocked, 'relay_unreachable');
// swiftc failed, the process was killed, or it printed nothing parseable.
assert.equal(repairOutcome(70, '').blocked, 'no_report');
assert.equal(repairOutcome(-1, undefined).blocked, 'no_report');
assert.equal(repairOutcome(1, '{"results": [').blocked, 'no_report');
const fine = repairOutcome(0, report(names.map((name) => entry(name, 'connected'))));
assert.deepEqual([fine.blocked, fine.connected, fine.total, fine.failed.length], [null, 9, 9, 0]);
assert.equal(repairOutcomeLine(fine), '9/9 연결 확인');
assert.equal(repairOutcomeLine(null), null);

// --- telling someone again ---------------------------------------------------
const health = (missing, extra = {}) => ({relayUp: true, expected: names, missing, failingDeep: [], ...extra});
assert.equal(isTotalOutage(health(names)), true);
assert.equal(isTotalOutage(health(names.slice(1))), false);
assert.equal(isTotalOutage(health([], {relayUp: false})), true);
assert.equal(isTotalOutage({relayUp: false, expected: [], missing: []}), false);   // nothing is required here
assert.equal(alertSignature(health(['b', 'a'])), alertSignature(health(['a', 'b'])));
assert.notEqual(alertSignature(health(['a'])), alertSignature(health(['a'], {failingDeep: ['a']})));

const opened = incidentSince;
const sigAt1808 = alertSignature(health([], {failingDeep: ['GW_Product']}));
const sigAllDown = alertSignature(health(names, {failingDeep: ['GW_Product']}));
const alert = (extra) => realertDecision({lastAlertAt: opened, lastSignature: sigAt1808, signature: sigAt1808, reminders: 0, now: opened, ...extra});
// Inside the hour, one failing project: the card is edited, nobody is paged again.
assert.equal(alert({now: opened + REALERT_AFTER_MS - 1}), null);
// An hour unanswered: a new message. (19:08 on the day.)
assert.equal(alert({now: opened + REALERT_AFTER_MS}), 'still_degraded');
// THE outage: 19:36:42 everything goes; a few polls later it is its own alert,
// whatever the reminder clock says.
const reminded = opened + REALERT_AFTER_MS;
assert.equal(alert({lastAlertAt: reminded, reminders: 1, totalSince: allDown, signature: sigAllDown, now: allDown + TOTAL_OUTAGE_CONFIRM_MS - 1}), null);
assert.equal(alert({lastAlertAt: reminded, reminders: 1, totalSince: allDown, signature: sigAllDown, now: allDown + TOTAL_OUTAGE_CONFIRM_MS}), 'total_outage');
// Once announced it is not announced again…
const announced = allDown + TOTAL_OUTAGE_CONFIRM_MS;
const during = (now, extra = {}) => alert({lastAlertAt: announced, lastSignature: sigAllDown, signature: sigAllDown, reminders: 1,
  totalSince: allDown, totalAlerted: true, now, ...extra});
assert.equal(during(announced + 60_000), null);
// …the same picture repeats every six hours, not every hour (2 more over the
// 14h46m, instead of 14 identical pages or none at all)…
assert.equal(during(announced + REALERT_AFTER_MS), null);
assert.equal(during(announced + REALERT_UNCHANGED_MS - 1), null);
assert.equal(during(announced + REALERT_UNCHANGED_MS), 'still_degraded');
// …and a changed picture is news again after an hour.
assert.equal(during(announced + REALERT_AFTER_MS, {signature: alertSignature(health(names.slice(2)))}), 'still_degraded');
assert.equal(during(announced + REALERT_AFTER_MS - 1, {signature: alertSignature(health(names.slice(2)))}), null);
// A relay restart is "relay gone" for one poll: not held long enough, no alert.
assert.equal(alert({totalSince: opened + 60_000, now: opened + 120_000}), null);
// A state file from before these fields carries no alert time: no reminder storm.
assert.equal(realertDecision({lastAlertAt: 0, now: opened + 10 * REALERT_AFTER_MS}), null);

// --- msg_too_long ------------------------------------------------------------
// Slack rejects chat.update/postMessage text past ~4,000 UTF-8 bytes; #84
// bounded the card (10,517 rejections in health.log before it, none after).
// The total-outage card is the longest this watcher writes — nine project
// lines plus every repair line — and must still fit with its tail intact.
const head = [':rotating_light: <@U0A91CC94TZ> *Figma 헬스체크 · 전면 끊김* — 필수 9개 전부 플러그인 없음',
  '• 일부 이상에서 전면 끊김으로 악화되어 새 메시지로 다시 알립니다 (지금 Figma 요청은 전부 실패합니다)',
  `• 플러그인 없음: ${names.join(', ')}`, '• 프로젝트별 상태:'];
const body = names.map((name) => `   :red_circle: ${name} — 플러그인 연결 · 유휴 · 심층 점검 미통과 (14시간 51분 전) — ${'문서 서버 조회 실패 '.repeat(12)}`);
const tail = ['• 자동 복구: 2026. 11. 10. 19시 46분 42초 실행 (exit 1 · 로그 ~/.talk-to-figma/link-repair.log) · 이번 이상 3회째',
  `  └ ${repairOutcomeLine(lockedReport)}`, ':link: <https://nexus.helinlabs.com/tunnel/svc/macmini-1/figma-relay/|웹 릴레이 콘솔 열기>'];
const card = fitSlackCard({head, body, tail});
assert.ok(slackBytes([...head, ...body, ...tail].join('\n')) > SLACK_TEXT_MAX_BYTES, 'fixture must overflow to prove anything');
assert.ok(slackBytes(card) <= SLACK_TEXT_MAX_BYTES, `card is ${slackBytes(card)} bytes`);
assert.ok(card.includes('전면 끊김') && card.includes('화면이 잠겨 있어 복구 불가') && card.endsWith(tail[2]), 'headline, blocker and link survive the cut');

console.log('health outage policy: ok');
