// When the health card names the link-down recovery, and when the watcher may
// run it by itself.
//
// Why this exists: from 2026-10-30 20:07 KST every product tab on macmini-1
// kept a live plugin while its document could not reach Figma's servers, for
// 38 hours. The card said "플러그인 재연결" the whole time — the one action that
// cannot fix it — because nothing told link-down apart from a missing plugin.
import assert from 'node:assert/strict';
import {LINK_REPAIR_AFTER_MS, isLinkDownDetail, linkFailureDetail, trackLinkDown, linkRepairPlan,
  linkRepairLine, shouldTriggerLinkRepair} from '../src/health_watch/report-policy.mjs';

const down = `2회 연속 실패 — 1차: ${linkFailureDetail({error: 'Unable to establish connection to Figma after 10 seconds'})} · pages 936ms · link 12056ms`;
const slow = `2회 연속 실패 — 1차: ${linkFailureDetail({error: 'no answer in 15000ms'})}`;

// Only Figma's own connection error is link-down; a slow lookup is not.
assert.equal(isLinkDownDetail(down), true);
assert.equal(isLinkDownDetail(slow), false);
assert.equal(isLinkDownDetail('plugin answered but reported no pages'), false);
assert.equal(isLinkDownDetail(undefined), false);

// The clock starts at the first down verdict and survives later ones.
const t0 = 1_000_000;
let since = trackLinkDown({}, {tproduct: {ok: false, at: t0, detail: down}, caproduct: {ok: true, at: t0, detail: ''}}, t0);
assert.deepEqual(since, {tproduct: t0});
since = trackLinkDown(since, {tproduct: {ok: false, at: t0 + 60_000, detail: down}}, t0 + 60_000);
assert.deepEqual(since, {tproduct: t0});
// A slow verdict or a pass clears it — the next outage gets a fresh clock.
assert.deepEqual(trackLinkDown(since, {tproduct: {ok: false, at: t0 + 1, detail: slow}}, t0 + 1), {});
assert.deepEqual(trackLinkDown(since, {tproduct: {ok: true, at: t0 + 1, detail: ''}}, t0 + 1), {});

// Nothing is proposed before the hold time; then idle projects are, busy ones are held.
const clocks = {tproduct: t0, caproduct: t0, gwproduct: t0 + LINK_REPAIR_AFTER_MS};
let plan = linkRepairPlan(clocks, {caproduct: 2}, t0 + LINK_REPAIR_AFTER_MS - 1);
assert.deepEqual(plan.ready, []);
assert.equal(linkRepairLine(plan), null);
plan = linkRepairPlan(clocks, {caproduct: 2}, t0 + LINK_REPAIR_AFTER_MS);
assert.deepEqual(plan.ready, ['tproduct']);
assert.deepEqual(plan.busy, ['caproduct']);
assert.deepEqual(plan.waiting, ['gwproduct']);
assert.equal(plan.since, t0);

const line = linkRepairLine(plan, (key) => key.toUpperCase());
assert.match(line, /figma-open-projects/);
assert.match(line, /Save and reload/);
assert.match(line, /플러그인 재실행으로는 안 고쳐짐/);
assert.match(line, /대상: TPRODUCT/);
assert.match(line, /작업 중이라 보류: CAPRODUCT/);
assert.match(line, /--link-check/);
assert.doesNotMatch(line, /GWPRODUCT/);

// The automatic run is opt-in, needs something ready, and happens once per incident.
const incidentSince = t0 - 5;
assert.equal(shouldTriggerLinkRepair(plan, {configured: false, triggeredAt: 0, incidentSince}), false);
assert.equal(shouldTriggerLinkRepair(plan, {configured: true, triggeredAt: 0, incidentSince}), true);
assert.equal(shouldTriggerLinkRepair(plan, {configured: true, triggeredAt: t0, incidentSince}), false);
// A run from an earlier incident does not block this one.
assert.equal(shouldTriggerLinkRepair(plan, {configured: true, triggeredAt: incidentSince - 1, incidentSince}), true);
// Busy-only never triggers: nobody's requests get a reload under them.
const busyOnly = linkRepairPlan({caproduct: t0}, {caproduct: 1}, t0 + LINK_REPAIR_AFTER_MS);
assert.equal(shouldTriggerLinkRepair(busyOnly, {configured: true, triggeredAt: 0, incidentSince}), false);
assert.match(linkRepairLine(busyOnly), /작업 중이라 보류/);

console.log('health link-repair policy: ok');
