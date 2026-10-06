// Locks which project the health watcher's deep check probes next.
//
// Why this exists: from 2026-10-02 19:46 to 10-06 14:36 the Slack card said
// T_Product and GW_Product were failing and that GW_Apple Watch (45h) and
// F_Product (83h) had gone stale. The stale two had not been probed once in
// that whole stretch, and CO_Product had been probed every other turn. The
// plugins had been re-run by then; the card only caught up when someone forced
// the rotation onto each project by hand.
//
// The replay below runs the watcher's turn timing against those conditions:
// three projects failing at once, a failing probe taking 93s (two 45s timeouts
// plus the pause), deep turns 2 minutes apart after a failure and 5 minutes
// apart otherwise, ticks once a minute. The shipped cursor picker probed
// GW_Apple Watch and F_Product zero times in 96 hours under exactly this.
//
// The policy lives in watch.ts as an evaluable block (same trick as
// speed-sample-policy) so this test and the watcher share one copy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const watchPath = fileURLToPath(new URL("../src/health_watch/watch.ts", import.meta.url));
const source = readFileSync(watchPath, "utf8");

const BEGIN = ">>> deep-pick-policy";
const END = "<<< deep-pick-policy";
const begin = source.indexOf(BEGIN);
const end = source.indexOf(END);
assert.ok(
  begin !== -1 && end !== -1 && end > begin,
  `src/health_watch/watch.ts must contain a "${BEGIN}" ... "${END}" block holding the pick policy`,
);
const block = source.slice(begin + BEGIN.length, end);
const { pickDeepTarget } = new Function(`${block}\nreturn { pickDeepTarget };`)();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DEEP_MS = 5 * MIN;
const pool = ["co", "ca", "gwaw", "gw", "d", "f", "t"].map((key) => ({ key }));

// --- single decisions -------------------------------------------------------

{
  const now = 10 * HOUR;
  const { target, retry } = pickDeepTarget(pool, {}, false, now, DEEP_MS);
  assert.equal(target.key, "co", "nothing probed yet: start at the top of the relay's list");
  assert.equal(retry, false);
}

{
  const now = 10 * HOUR;
  const results = Object.fromEntries(pool.map(({ key }, index) => [key, { at: now - index * MIN, ok: true }]));
  delete results.f;
  const { target } = pickDeepTarget(pool, results, false, now, DEEP_MS);
  assert.equal(target.key, "f", "a project never probed goes before every probed one");
}

{
  const now = 10 * HOUR;
  const results = {
    co: { at: now - 6 * MIN, ok: false },
    t: { at: now - 20 * MIN, ok: false },
    ca: { at: now - 60 * MIN, ok: true },
  };
  const { target, retry } = pickDeepTarget(pool, results, false, now, DEEP_MS);
  assert.equal(target.key, "t", "of two failures due a retry, the one probed longest ago — not the one listed first");
  assert.equal(retry, true);
}

{
  const now = 10 * HOUR;
  const results = Object.fromEntries(pool.map(({ key }) => [key, { at: now - 30 * MIN, ok: true }]));
  results.co = { at: now - 6 * MIN, ok: false };
  results.ca = { at: now - 90 * MIN, ok: true };
  const { target, retry } = pickDeepTarget(pool, results, true, now, DEEP_MS);
  assert.equal(retry, false, "a retry never takes two turns running");
  assert.equal(target.key, "ca", "the turn after a retry belongs to the rotation");
}

{
  const now = 10 * HOUR;
  const results = Object.fromEntries(pool.map(({ key }) => [key, { at: now - 30 * MIN, ok: true }]));
  results.co = { at: now - 2 * MIN, ok: false };
  const { retry } = pickDeepTarget(pool, results, false, now, DEEP_MS);
  assert.equal(retry, false, "a failure probed under DEEP_MS ago waits its turn");
}

// --- the 2026-10-02 replay ---------------------------------------------------

function replay(failing, hours) {
  const results = {};
  const probes = {};
  const maxGap = {};
  let lastWasRetry = false;
  let lastDeepAt = -Infinity;
  let lastOk = true;
  let now = 0;
  while (now < hours * HOUR) {
    if (now - lastDeepAt >= (lastOk ? DEEP_MS : 2 * MIN)) {
      lastDeepAt = now;
      const pick = pickDeepTarget(pool, results, lastWasRetry, now, DEEP_MS);
      lastWasRetry = pick.retry;
      const key = pick.target.key;
      now += failing.has(key) ? 93_000 : 1_000;   // the tick blocks while it probes
      const previous = results[key]?.at;
      if (previous != null) maxGap[key] = Math.max(maxGap[key] || 0, now - previous);
      results[key] = { at: now, ok: !failing.has(key) };
      lastOk = results[key].ok;
      probes[key] = (probes[key] || 0) + 1;
    }
    now = (Math.floor(now / MIN) + 1) * MIN;      // next minute tick
  }
  return { probes, maxGap };
}

{
  const { probes, maxGap } = replay(new Set(["co", "gw", "t"]), 96);
  for (const { key } of pool) {
    assert.ok(probes[key] > 0, `${key} was never probed in 96 hours`);
    // Seven projects, at most every other turn spent on retries, turns 2-5
    // minutes apart: a full lap fits comfortably inside an hour.
    assert.ok(maxGap[key] < HOUR, `${key} went ${(maxGap[key] / HOUR).toFixed(1)}h between probes`);
  }
  // Each failure still gets looked at far more often than once a lap, which is
  // how a recovery shows up on the card quickly.
  for (const key of ["co", "gw", "t"]) {
    assert.ok(maxGap[key] < 30 * MIN, `failing ${key} went ${(maxGap[key] / MIN).toFixed(0)}min between probes`);
  }
  const busiest = Math.max(...Object.values(probes));
  const quietest = Math.min(...Object.values(probes));
  assert.ok(busiest / quietest < 4, `probe counts too uneven: ${JSON.stringify(probes)}`);
}

{
  // Everything failing: retries cannot starve anyone because there is no one
  // left outside them, and nobody is skipped.
  const { probes, maxGap } = replay(new Set(pool.map(({ key }) => key)), 24);
  for (const { key } of pool) {
    assert.ok(probes[key] > 0 && maxGap[key] < HOUR, `${key} starved with every project failing`);
  }
}

{
  // Everything healthy: plain rotation, each project once per lap.
  const { probes } = replay(new Set(), 24);
  const counts = Object.values(probes);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `healthy rotation uneven: ${JSON.stringify(probes)}`);
}

console.log("health-deep-pick-policy: ok");
