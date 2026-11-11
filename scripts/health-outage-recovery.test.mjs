// The real watcher process, driven through the 2026-11-10 outage with a stand-in
// relay, a stand-in Slack and a stand-in launcher.
//
// What happened then: one project failing → every plugin gone → 14h46m of the
// same card being edited, no new message, no launcher run. What must happen:
//   - a plugin that stays missing sends the launcher, and sends it again;
//   - a run that could not work says why on the card (locked screen), and a
//     run that met another launcher's lock (exit 75) is left alone, then retried;
//   - partial → total is a NEW top-level message, once;
//   - an incident nobody answered is said again once, not on every clock tick;
//   - when the plugins come back the launcher is not sent again.
// Timings are the production ones scaled down through the HEALTH_* knobs.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

if (spawnSync('bun', ['--version']).status !== 0) {
  console.log('health outage recovery: skipped (needs bun)');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'health-outage-'));
const names = ['Alpha_Product', 'Beta_Product', 'Gamma_Product'];
let live = [...names];

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const json = (response, body, status = 200) => {
  response.writeHead(status, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(body));
};

// No recommendedChannel: the deep probe has nothing to pick, so this is the
// shallow picture only — which is all "플러그인 없음" is.
const relay = await listen((request, response) => {
  if (request.url === '/health') return json(response, {ok: true});
  if (request.url === '/projects') return json(response, {projects: live.map((name) => ({name, connectionCount: 1}))});
  return json(response, {error: 'not found'}, 404);
});

const slackCalls = [];
let nextTs = 1000;
const slack = await listen((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const method = request.url.split('/').pop();
    const ts = method === 'chat.postMessage' ? String(++nextTs) : body.ts;
    slackCalls.push({method, ts, thread: body.thread_ts ?? null, text: String(body.text ?? ''), bytes: Buffer.byteLength(String(body.text ?? ''))});
    json(response, {ok: true, ts});
  });
});

// The launcher: appends one line per run, then prints whatever report and
// exits with whatever code the test has staged.
const runsFile = join(dir, 'runs.log');
const stageFile = join(dir, 'stage.json');
const codeFile = join(dir, 'stage.code');
const launcher = join(dir, 'run-broker.sh');
writeFileSync(launcher, `#!/bin/sh\necho run >> "${runsFile}"\ncat "${stageFile}"\nexit "$(cat "${codeFile}")"\n`);
chmodSync(launcher, 0o755);
const stage = (code, results, stderrLine = '') => {
  writeFileSync(stageFile, stderrLine + JSON.stringify({ok: code === 0, dryRun: false, results}, null, 2));
  writeFileSync(codeFile, String(code));
};
const result = (title, status, step = null) => ({id: title, title, status, step, detail: '', url: ''});
const runs = () => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).length : 0);

writeFileSync(join(dir, 'projects.json'), JSON.stringify({
  defaultProjectIDs: names.map((name) => name.toLowerCase()),
  projects: names.map((name) => ({id: name.toLowerCase(), title: name})),
}));

const port = 20000 + Math.floor(Math.random() * 20000);
const HOLD = 1500, BUSY = 1500, REALERT = 3000;
const watcher = spawn('bun', ['run', new URL('../src/health_watch/watch.ts', import.meta.url).pathname], {
  env: {
    ...process.env, HOME: dir,
    HEALTH_RELAY_HTTP: `http://127.0.0.1:${relay.address().port}`, HEALTH_RELAY_WS: 'ws://127.0.0.1:9',
    HEALTH_SLACK_API: `http://127.0.0.1:${slack.address().port}`, HEALTH_SLACK_TOKEN: 'test', HEALTH_SLACK_CHANNEL: 'C_TEST',
    HEALTH_PORT: String(port), HEALTH_STATE_PATH: join(dir, 'state.json'), HEALTH_PROJECTS_JSON: join(dir, 'projects.json'),
    HEALTH_LINK_REPAIR_CMD: launcher,
    HEALTH_SHALLOW_MS: '150', HEALTH_FAIL_STREAK: '2', HEALTH_DEEP_MS: '3600000',
    HEALTH_HEALTHY_UPDATE_MS: '150', HEALTH_DEGRADED_UPDATE_MS: '150', HEALTH_SPEED_UPDATE_MS: '3600000',
    HEALTH_PLUGIN_REPAIR_MS: String(HOLD), HEALTH_REPAIR_BUSY_RETRY_MS: String(BUSY), HEALTH_LINK_REPAIR_RETRY_MS: '600000',
    HEALTH_TOTAL_OUTAGE_CONFIRM_MS: '450', HEALTH_REALERT_MS: String(REALERT), HEALTH_REALERT_UNCHANGED_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
watcher.stdout.on('data', (chunk) => { log += chunk; });
watcher.stderr.on('data', (chunk) => { log += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, test, timeoutMs = 12_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = test();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}\n--- slack ---\n${slackCalls.map((call) => `${call.method} ${call.ts} ${call.text.split('\n')[0]}`).join('\n')}\n--- watcher ---\n${log}`);
}
const topLevel = () => slackCalls.filter((call) => call.method === 'chat.postMessage' && !call.thread);
const lastTextFor = (ts) => slackCalls.filter((call) => call.ts === ts && !call.thread).at(-1)?.text ?? '';
const status = async () => (await fetch(`http://127.0.0.1:${port}/`)).json();

try {
  // All three live: the all-clear card.
  await until('all-clear card', () => topLevel().some((call) => call.text.includes('이상 없음')));
  assert.equal(runs(), 0);

  // --- one project loses its plugin: the incident opens ----------------------
  stage(1, [result('Alpha_Product', 'plugin_failed', 'connect_timeout'), result('Beta_Product', 'connected'), result('Gamma_Product', 'connected')]);
  live = ['Beta_Product', 'Gamma_Product'];
  const opening = await until('opening alert', () => topLevel().find((call) => call.text.includes('이상 감지')));
  assert.match(opening.text, /플러그인 없음: Alpha_Product/);
  assert.equal(runs(), 0, 'not on the tick that opens the incident, and not before the hold time');
  // Before the hold time the card says the launcher is coming, and when.
  await until('card announces the automatic run', () => /플러그인 없음 자동 복구: .*런처를 자동 실행/.test(lastTextFor(opening.ts)));
  // Held missing: the launcher is sent, by the watcher, with nobody asking.
  await until('first launcher run', () => runs() >= 1, HOLD + 4000);
  await until('failed run explained on the card', () => /실패: Alpha_Product\(plugin_failed\/connect_timeout\)/.test(lastTextFor(opening.ts)));
  // …and sent again while it stays missing (back-off from the busy interval).
  await until('retry after a failed run', () => runs() >= 2, BUSY + 4000);

  // Unanswered for the re-alert time: said again as a NEW message, once.
  const reminder = await until('reminder', () => topLevel().find((call) => call.text.includes('다시 알림')), REALERT + 4000);
  assert.notEqual(reminder.ts, opening.ts);
  assert.match(reminder.text, /<@U[A-Z0-9]+>/, 'a re-alert mentions the person again');
  assert.match(lastTextFor(opening.ts), /새 알림으로 이어졌습니다/, 'the replaced card points at the new one');
  assert.equal((await status()).alerts.cardTs, reminder.ts, 'the new message is now the card that gets rewritten');

  // --- everything goes: 19:36 ------------------------------------------------
  stage(1, names.map((name) => result(name, 'screen_locked', 'screen_locked')));
  const runsBefore = runs();
  live = [];
  const total = await until('total-outage alert', () => topLevel().find((call) => call.text.includes('전면 끊김')));
  assert.notEqual(total.ts, reminder.ts, 'partial → total is a new top-level message, not an edit');
  assert.match(total.text, /새 메시지로 다시 알립니다/);
  assert.match(total.text, /필수 3개 전부 플러그인 없음/);
  // The two that just broke did so after the last run: no waiting out its clock.
  await until('launcher sent for the new losses', () => runs() > runsBefore, HOLD + BUSY + 4000);
  // A locked screen: the card names it and who must act.
  await until('lock reason on the card', () => /화면이 잠겨 있어 복구 불가/.test(lastTextFor(total.ts)));
  assert.equal((await status()).linkRepair.result.blocked, 'screen_locked');

  // Another launcher holds the lock: exit 75 is respected (reported as not a
  // failure) and simply asked again later.
  stage(75, names.map((name) => result(name, 'repair_in_progress')), 'another launcher run is still repairing; not starting a second one\n');
  const beforeGuard = runs();
  await until('run that meets the guard', () => runs() > beforeGuard, BUSY + 4000);
  await until('guard on the card', () => /exit 75 — 실패 아님/.test(lastTextFor(total.ts)));
  const afterGuard = runs();
  await sleep(BUSY / 3);
  assert.equal(runs(), afterGuard, 'no second run on top of the one holding the lock');
  await until('asked again after the guard interval', () => runs() > afterGuard, BUSY + 4000);

  // --- the launcher works; plugins return -------------------------------------
  stage(0, names.map((name) => result(name, 'connected')));
  live = [...names];
  await until('recovery message', () => topLevel().some((call) => call.text.includes('복구됨')));
  await until('all-clear card after the incident', () => topLevel().some((call) => call.text.includes('이상 없음') && Number(call.ts) > Number(total.ts)));
  const settled = runs();
  await sleep(HOLD + BUSY);
  assert.equal(runs(), settled, 'a healthy watcher does not send the launcher');

  // One alert per thing worth an alert — not one per tick, and not zero.
  assert.equal(topLevel().filter((call) => call.text.includes('전면 끊김')).length, 1, 'total outage announced exactly once');
  assert.equal(topLevel().filter((call) => call.text.includes('다시 알림')).length, 1, 'an unchanged outage is not re-announced inside the long interval');
  assert.equal(topLevel().filter((call) => call.text.includes('이상 감지') && !call.text.includes('다시 알림')).length, 1);
  // Nothing this watcher sent could have been rejected as msg_too_long.
  const longest = Math.max(...slackCalls.map((call) => call.bytes));
  assert.ok(longest <= 3900, `longest Slack text was ${longest} bytes`);
  assert.doesNotMatch(log, /msg_too_long|tick failed/);
  console.log(`health outage recovery: ok (${runs()} launcher runs, ${topLevel().length} top-level messages, longest text ${longest} bytes)`);
} finally {
  watcher.kill('SIGKILL');
  relay.close();
  slack.close();
  rmSync(dir, {recursive: true, force: true});
}
