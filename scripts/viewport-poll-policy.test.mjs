// Locks the console's viewport-poll retry policy.
//
// Why this exists: on 2026-08-27 the console's live-preview viewport poll ran
// against a Figma plugin build that did not implement `get_viewport`. The poll
// was a plain `setInterval(read, 5000)` with no failure handling, so it kept
// asking forever. The relay answered every attempt with 502 and wrote an entry
// to the error ledger: 791 identical `Unknown command: get_viewport` errors
// between 11:44:35Z and 14:30:37Z. Those same requests reach the relay through
// the Nexus service tunnel, where they showed up as 786 of the 2,876 GET
// /tunnel/svc requests in the matching window — 27.33% 5xx on a production
// route, all of it this one poll.
//
// The policy lives in console.html (a single-file browser app, no bundler), so
// this test reads the file and evaluates the sentinel-delimited policy block.
// That keeps one copy of the logic: the browser runs the same source this test
// asserts on.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const consolePath = fileURLToPath(new URL("../src/console.html", import.meta.url));
const html = readFileSync(consolePath, "utf8");

const BEGIN = ">>> viewport-poll-policy";
const END = "<<< viewport-poll-policy";
const begin = html.indexOf(BEGIN);
const end = html.indexOf(END);
assert.ok(
  begin !== -1 && end !== -1 && end > begin,
  `src/console.html must contain a "${BEGIN}" ... "${END}" block holding the viewport poll policy`,
);
const block = html.slice(begin + BEGIN.length, end);

const policy = new Function(`${block}\nreturn { nextViewportPollDelay, isPermanentViewportError, VP_POLL_MS, VP_POLL_MAX_MS, VP_POLL_PARKED_MS };`)();
const { nextViewportPollDelay, isPermanentViewportError, VP_POLL_MS, VP_POLL_MAX_MS, VP_POLL_PARKED_MS } = policy;

// The block must be self-contained — it carries its own constants so the
// browser and this test cannot drift apart.
assert.equal(typeof nextViewportPollDelay, "function");
assert.equal(typeof isPermanentViewportError, "function");
assert.ok(VP_POLL_MS > 0 && VP_POLL_MAX_MS > VP_POLL_MS && VP_POLL_PARKED_MS > VP_POLL_MAX_MS);

// A healthy poll stays at the fast cadence, and a recovery snaps back to it
// from anywhere in the backoff.
assert.equal(nextViewportPollDelay(VP_POLL_MS, { ok: true }), VP_POLL_MS);
assert.equal(nextViewportPollDelay(VP_POLL_MAX_MS, { ok: true }), VP_POLL_MS);
assert.equal(nextViewportPollDelay(VP_POLL_PARKED_MS, { ok: true }), VP_POLL_MS);

// Transient failures (plugin restarting, relay blip) back off geometrically and
// stop at the ceiling — they must not park, because they do recover on their own.
let delay = VP_POLL_MS;
const transient = { ok: false, error: "No live Figma plugin for project \"GW_Product\"" };
const schedule = [];
for (let i = 0; i < 8; i++) {
  delay = nextViewportPollDelay(delay, transient);
  schedule.push(delay);
}
assert.deepEqual(schedule, [10000, 20000, 40000, 60000, 60000, 60000, 60000, 60000]);
assert.equal(VP_POLL_MAX_MS, 60000);

// A capability gap is permanent for as long as that plugin build stays
// connected: parking immediately is the whole point, so it must not have to
// climb the transient ladder first.
const permanent = { ok: false, error: "Unknown command: get_viewport" };
assert.equal(nextViewportPollDelay(VP_POLL_MS, permanent), VP_POLL_PARKED_MS);
assert.equal(nextViewportPollDelay(VP_POLL_MAX_MS, permanent), VP_POLL_PARKED_MS);
assert.equal(nextViewportPollDelay(VP_POLL_PARKED_MS, permanent), VP_POLL_PARKED_MS);

assert.ok(isPermanentViewportError("Unknown command: get_viewport"));
assert.ok(isPermanentViewportError("unknown command: set_viewport"));
assert.ok(!isPermanentViewportError("Internal command get_viewport timed out after 15000ms"));
assert.ok(!isPermanentViewportError("Figma plugin disconnected while executing the request"));
assert.ok(!isPermanentViewportError(""));
assert.ok(!isPermanentViewportError(undefined));

// Replay the real incident: 11:44:35Z -> 14:30:37Z of an unbroken capability
// failure. The old fixed 5s interval issued 791 requests (and would have issued
// ~1,986 had the tab stayed foregrounded the whole time). Parking has to cut
// that to a trickle, or the fix is cosmetic.
const INCIDENT_MS = (14 * 60 + 30) * 60_000 + 37_000 - ((11 * 60 + 44) * 60_000 + 35_000);
let elapsed = 0;
let requests = 0;
delay = VP_POLL_MS;
while (elapsed < INCIDENT_MS) {
  requests++;
  delay = nextViewportPollDelay(delay, permanent);
  elapsed += delay;
}
assert.ok(
  requests <= 40,
  `a ${Math.round(INCIDENT_MS / 60000)}min capability outage must cost <=40 requests, got ${requests} (observed before the fix: 791)`,
);

// The poll itself must be a self-rescheduling timeout. A setInterval cannot
// honour a delay that changes per outcome, so its return would silently undo
// everything above.
const hookStart = html.indexOf("function useViewportControl");
assert.ok(hookStart !== -1, "useViewportControl must exist in src/console.html");
const hook = html.slice(hookStart, matchingBraceEnd(html, html.indexOf("{", hookStart)) + 1);
assert.ok(
  !/setInterval\s*\(/.test(hook),
  "useViewportControl must not use setInterval — the poll delay is outcome-dependent",
);
assert.ok(/setTimeout\s*\(/.test(hook), "useViewportControl must reschedule its poll with setTimeout");

// console.html is only ever parsed in a browser (Babel standalone, no build
// step), so a syntax slip in this hook ships silently and blanks the whole
// console. Constructing a Function parses the source without running it.
// The hook is plain JS — no JSX — so this is a real parse of real code.
assert.doesNotThrow(
  () => new Function("React", "useState", "useRef", "useCallback", "useEffect", "relayApiUrl", `${block}\n${hook}`),
  "policy block + useViewportControl must parse as JavaScript",
);

function matchingBraceEnd(source, openIndex) {
  assert.equal(source[openIndex], "{");
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i;
  }
  throw new Error("unbalanced braces while reading useViewportControl");
}

console.log(`viewport poll policy OK — ${Math.round(INCIDENT_MS / 60000)}min capability outage costs ${requests} requests (was 791)`);
