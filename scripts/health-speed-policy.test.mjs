// Locks what the health watcher is willing to call a measurement.
//
// Why this exists: on 2026-09-03 the speed card in Slack reported
//
//   • 심층 점검 450359962743.0s ▲450359962735.9s
//   • 최근 심층: … GW_Product 9007199254741.0s …
//
// 9007199254741s is Number.MAX_SAFE_INTEGER divided by 1000, and 450359962743
// is that same number spread over a twenty-sample average. The deep check took
// the lower of its two attempts with
//
//   Math.min(...passes.map((attempt) => attempt.ms ?? Number.MAX_SAFE_INTEGER))
//
// where the sentinel was only ever meant to lose the comparison. When every
// passing attempt was missing a timing, the sentinel won and left as the
// measurement — into the history file, into the average, and into the outlier
// alert, which would have paged someone for a "slow" check that never ran.
//
// A missing number has to stay missing. This test pins that at all three
// places it can leak: producing a sample, averaging samples, and reading back
// the history file a deploy does not clear.
//
// The policy lives in watch.ts as an evaluable block (same trick as the
// console's viewport-poll policy) so this test and the watcher share one copy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const watchPath = fileURLToPath(new URL("../src/health_watch/watch.ts", import.meta.url));
const source = readFileSync(watchPath, "utf8");

const BEGIN = ">>> speed-sample-policy";
const END = "<<< speed-sample-policy";
const begin = source.indexOf(BEGIN);
const end = source.indexOf(END);
assert.ok(
  begin !== -1 && end !== -1 && end > begin,
  `src/health_watch/watch.ts must contain a "${BEGIN}" ... "${END}" block holding the sample policy`,
);
const block = source.slice(begin + BEGIN.length, end);

const { usableMs, mean, MAX_PLAUSIBLE_MS } =
  new Function(`${block}\nreturn { usableMs, mean, MAX_PLAUSIBLE_MS };`)();

// --- what counts as a measurement -----------------------------------------

assert.equal(usableMs(82), true, "an ordinary relay reading");
assert.equal(usableMs(0), true, "zero is a real answer, not a missing one");
assert.equal(usableMs(28_100), true, "a slow but real deep check");

assert.equal(usableMs(undefined), false, "a missing timing must stay missing");
assert.equal(usableMs(null), false);
assert.equal(usableMs(NaN), false);
assert.equal(usableMs(Infinity), false);
assert.equal(usableMs(-1), false, "time does not run backwards");
assert.equal(usableMs("82"), false, "a string is not a duration");

// The exact value that shipped to Slack.
assert.equal(usableMs(Number.MAX_SAFE_INTEGER), false, "the sentinel is not a measurement");
assert.ok(MAX_PLAUSIBLE_MS <= 60 * 60_000, "an hour is already generous for a check that times out in seconds");

// --- one bad sample must not move the average ------------------------------

// Twenty ordinary checks and one sentinel: this is the shape that produced
// 450359962743.0s on the card.
const poisoned = [...Array(19).fill(3_000), Number.MAX_SAFE_INTEGER];
const average = mean(poisoned);
assert.ok(average !== null, "nineteen good samples still have an average");
assert.equal(average, 3_000, `one unusable sample must not move the mean (got ${average})`);

assert.equal(mean([]), null, "no samples is not the same as zero");
assert.equal(mean([undefined, NaN]), null, "nothing usable is also not zero");
assert.equal(mean([1_000, 2_000]), 1_500);

console.log("health speed sample policy ok");
