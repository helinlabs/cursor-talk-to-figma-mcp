// When the health card names the link-down recovery, and when the watcher may
// run it by itself.
//
// Why this exists: from 2026-10-30 20:07 KST every product tab on macmini-1
// kept a live plugin while its document could not reach Figma's servers, for
// 38 hours. The card said "플러그인 재연결" the whole time — the one action that
// cannot fix it — because nothing told link-down apart from a missing plugin.
import assert from 'node:assert/strict';
import {LINK_REPAIR_AFTER_MS, isLinkDownDetail, linkFailureDetail, trackLinkDown, linkRepairPlan,
  linkRepairLine, shouldTriggerRepair, nextRepairAt, resolveLinkRepairCmd,
  LINK_REPAIR_RETRY_MS, LINK_REPAIR_BUSY_RETRY_MS} from '../src/health_watch/report-policy.mjs';

// The link-down half of the one repair decision (the plugin-missing half is in
// health-outage-policy.test.mjs). Same assertions as before the two were merged.
const shouldTriggerLinkRepair = (linkPlan, options) => shouldTriggerRepair({linkPlan, ...options});
const nextLinkRepairAt = nextRepairAt;

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

// The automatic run needs a command and something ready; the first one in an
// incident goes at once.
const incidentSince = t0 - 5;
const now = t0 + LINK_REPAIR_AFTER_MS;
assert.equal(shouldTriggerLinkRepair(plan, {configured: false, triggeredAt: 0, incidentSince, now}), false);
assert.equal(shouldTriggerLinkRepair(plan, {configured: true, triggeredAt: 0, incidentSince, now}), true);
// A run from an earlier incident does not block this one.
assert.equal(shouldTriggerLinkRepair(plan, {configured: true, triggeredAt: incidentSince - 1, incidentSince, now}), true);
// Busy-only never triggers: nobody's requests get a reload under them.
const busyOnly = linkRepairPlan({caproduct: t0}, {caproduct: 1}, t0 + LINK_REPAIR_AFTER_MS);
assert.equal(shouldTriggerLinkRepair(busyOnly, {configured: true, triggeredAt: 0, incidentSince, now}), false);

// Inside an incident it retries — hourly after a run that finished, sooner
// after one that met another launcher's lock (exit 75), never on top of a run
// still going. 2026-11-05 was 15 hours behind a locked screen: one shot at the
// start of that could only fail, and nothing would have tried again.
const ran = now;
const done = {at: ran + 90_000, code: 1};
const opts = (extra) => ({configured: true, triggeredAt: ran, incidentSince, ...extra});
assert.equal(shouldTriggerLinkRepair(plan, opts({running: true, now: ran + 5 * LINK_REPAIR_RETRY_MS})), false);
assert.equal(shouldTriggerLinkRepair(plan, opts({result: done, now: ran + LINK_REPAIR_RETRY_MS - 1})), false);
assert.equal(shouldTriggerLinkRepair(plan, opts({result: done, now: ran + LINK_REPAIR_RETRY_MS})), true);
// A watcher restart forgets the child but not the clock: no result, still hourly.
assert.equal(shouldTriggerLinkRepair(plan, opts({result: null, now: ran + LINK_REPAIR_BUSY_RETRY_MS})), false);
assert.equal(shouldTriggerLinkRepair(plan, opts({result: null, now: ran + LINK_REPAIR_RETRY_MS})), true);
const locked = {at: ran + 25_000, code: 75};
assert.ok(LINK_REPAIR_BUSY_RETRY_MS < LINK_REPAIR_RETRY_MS);
assert.equal(shouldTriggerLinkRepair(plan, opts({result: locked, now: ran + LINK_REPAIR_BUSY_RETRY_MS - 1})), false);
assert.equal(shouldTriggerLinkRepair(plan, opts({result: locked, now: ran + LINK_REPAIR_BUSY_RETRY_MS})), true);
// A result older than the run it is compared with is not that run's result.
assert.equal(shouldTriggerLinkRepair(plan, opts({result: {at: ran - 1, code: 75}, now: ran + LINK_REPAIR_BUSY_RETRY_MS})), false);
// Custom cadence.
assert.equal(shouldTriggerLinkRepair(plan, opts({result: done, retryMs: 1000, now: ran + 1000})), true);
assert.equal(nextLinkRepairAt({triggeredAt: ran, result: done}), ran + LINK_REPAIR_RETRY_MS);
assert.equal(nextLinkRepairAt({triggeredAt: ran, result: locked}), ran + LINK_REPAIR_BUSY_RETRY_MS);
assert.equal(nextLinkRepairAt({triggeredAt: 0, result: null}), null);

// On by default where the launcher is installed; the env var overrides, and
// an empty / "off" value switches it off on purpose.
const home = '/Users/someone';
const launcher = `${home}/.codex/skills/figma-product-mcp/scripts/run-broker.sh`;
const installed = (path) => path === launcher;
assert.equal(resolveLinkRepairCmd({}, home, installed), launcher);
assert.equal(resolveLinkRepairCmd({}, home, () => false), '');
assert.equal(resolveLinkRepairCmd({HEALTH_LINK_REPAIR_CMD: '/opt/x/repair.sh --all'}, home, installed), '/opt/x/repair.sh --all');
for (const off of ['', ' ', 'off', 'OFF', '0', 'false', 'no']) {
  assert.equal(resolveLinkRepairCmd({HEALTH_LINK_REPAIR_CMD: off}, home, installed), '', `"${off}" must disable`);
}
assert.match(linkRepairLine(busyOnly), /작업 중이라 보류/);

console.log('health link-repair policy: ok');
