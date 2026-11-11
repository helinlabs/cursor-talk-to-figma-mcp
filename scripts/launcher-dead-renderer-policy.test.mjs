// The launcher's "Figma has no renderers" decision, compiled and run for real.
//
// The outage this replays: macmini-1, 2026-11-10 19:35:40 KST. Every helper
// under the Figma process died at once; the main process (pid 80260) stayed and
// only its GPU and utility helpers came back. Ten windows kept their titles and
// held no document, the relay listed no plugin, and `run-broker.sh` exited 1
// after 28s with nine `separation_failed / renderer_accessibility` — for 14
// hours 46 minutes, until a person's session pressed Help > Troubleshooting >
// Reload All Tabs. The run must now reach that decision by itself, and must not
// reach it in any state where a reload would cost something.
//
// Same arrangement as launcher-link-policy.test.mjs: the pure block between the
// `dead-renderer-policy` markers is compiled with a driver. Needs swiftc, i.e.
// macOS; on the Linux CI runner it says so and passes.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const source = readFileSync(new URL('../skills/figma-product-mcp/scripts/figma_product_mcp.swift', import.meta.url), 'utf8');
const begin = source.indexOf('// >>> dead-renderer-policy');
const end = source.indexOf('// <<< dead-renderer-policy');
assert.ok(begin >= 0 && end > begin, 'dead-renderer-policy markers missing from the launcher');
const block = source.slice(begin, end);

// Wiring that no pure test can see, checked on every platform: the decision is
// taken before the per-project work, its outcome reaches the report, and the
// run goes on to open/attach instead of exiting.
const main = source.slice(source.indexOf('\ndo {'));
const decideAt = main.indexOf('deadRendererDecision(');
assert.ok(decideAt > 0, 'the run never asks deadRendererDecision');
assert.ok(decideAt < main.indexOf('var linkHeld'), 'decision must come before the link repair pass');
assert.ok(decideAt < main.indexOf('if openProject(project, app: app'), 'decision must come before files are opened');
assert.ok(decideAt > main.indexOf('if screenIsLocked()'), 'a locked screen is settled first, touching nothing');
const branch = main.slice(decideAt, main.indexOf('var linkHeld'));
assert.match(branch, /pressReloadAllTabs\(root\)/, 'the decision presses Reload All Tabs');
assert.doesNotMatch(branch, /exit\(/, 'the dead-renderer branch must carry on to reopen and attach, not exit');
assert.match(branch, /accessibilityReady = /, 'the renderer tree is re-read after the reload');
assert.match(main, /recovery: recovery/, 'the report says what was done');
assert.doesNotMatch(source, /terminate\(\)|forceTerminate\(\)|killall/, 'the launcher never quits Figma');

const swiftc = spawnSync('xcrun', ['--find', 'swiftc'], {encoding: 'utf8'});
if (process.platform !== 'darwin' || swiftc.status !== 0) {
  console.log('launcher dead renderer policy: wiring ok; decision table skipped (needs swiftc on macOS)');
  process.exit(0);
}

const driver = String.raw`
import Foundation
${block}
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

// ps -axo pid=,ppid=,command= as it looked during the outage: main process,
// GPU + utility helpers restarted at 19:35:41, crashpad — and no renderer.
let outage = """
80260     1 /Applications/Figma.app/Contents/MacOS/Figma
 2973 80260 /Applications/Figma.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler
71101 80260 /Applications/Figma.app/Contents/Frameworks/Figma Helper (GPU).app/Contents/MacOS/Figma Helper (GPU) --type=gpu-process --user-data-dir=/Users/macmini_m1/Library/Application Support/Figma/DesktopProfile/v40
71102 80260 /Applications/Figma.app/Contents/Frameworks/Figma Helper.app/Contents/MacOS/Figma Helper --type=utility --utility-sub-type=network.mojom.NetworkService
  501     1 /Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer) --type=renderer
 9001  9000 /Applications/Figma.app/Contents/Frameworks/Figma Helper (Renderer).app/Contents/MacOS/Figma Helper (Renderer) --type=renderer --lang=en-US
"""
let healthy = outage + """

71200 80260 /Applications/Figma.app/Contents/Frameworks/Figma Helper (Renderer).app/Contents/MacOS/Figma Helper (Renderer) --type=renderer --lang=en-US
71201 80260 /Applications/Figma.app/Contents/Frameworks/Figma Helper (Renderer).app/Contents/MacOS/Figma Helper (Renderer) --type=renderer --lang=en-US
"""
check(figmaRendererCount(psOutput: outage, figmaPID: 80260) == 0, "outage: this Figma has no renderer (Slack's and another Figma's do not count)")
check(figmaRendererCount(psOutput: healthy, figmaPID: 80260) == 2, "healthy: counts this Figma's renderers")
check(figmaRendererCount(psOutput: healthy, figmaPID: 9000) == 1, "counts by parent pid")
check(figmaRendererCount(psOutput: "", figmaPID: 80260) == 0, "empty ps output")

// The outage itself: tree down, unlocked, relay up with nothing on it, ten
// shells, zero renderers.
check(deadRendererDecision(accessibilityReady: false, screenLocked: false, relayReachable: true,
    livePlugins: 0, windowCount: 10, rendererCount: figmaRendererCount(psOutput: outage, figmaPID: 80260)) == .reloadAllTabs,
    "11-10 outage: reload all tabs")

func leaves(_ decision: DeadRendererDecision) -> Bool { if case .leave = decision { return true }; return false }
// Every way a reload could cost something, or would be pointless, is left alone.
check(leaves(deadRendererDecision(accessibilityReady: true, screenLocked: false, relayReachable: true, livePlugins: 0, windowCount: 10, rendererCount: 0)), "tree is up")
check(leaves(deadRendererDecision(accessibilityReady: false, screenLocked: true, relayReachable: true, livePlugins: 0, windowCount: 10, rendererCount: 0)), "locked screen: nothing can be driven")
check(leaves(deadRendererDecision(accessibilityReady: false, screenLocked: false, relayReachable: false, livePlugins: 0, windowCount: 10, rendererCount: 0)), "relay down: live plugins cannot be ruled out")
check(leaves(deadRendererDecision(accessibilityReady: false, screenLocked: false, relayReachable: true, livePlugins: 1, windowCount: 10, rendererCount: 0)), "one live plugin is one too many")
check(leaves(deadRendererDecision(accessibilityReady: false, screenLocked: false, relayReachable: true, livePlugins: 0, windowCount: 0, rendererCount: 0)), "no window: opening files starts renderers")
check(leaves(deadRendererDecision(accessibilityReady: false, screenLocked: false, relayReachable: true, livePlugins: 0, windowCount: 10, rendererCount: nil)), "ps failed: unknown is not zero")
// Figma 126.8.16 ignoring AXManualAccessibility: no tree, but documents are loaded.
check(leaves(deadRendererDecision(accessibilityReady: false, screenLocked: false, relayReachable: true, livePlugins: 0, windowCount: 10, rendererCount: 11)), "renderers running: only the tree is missing")

if failures > 0 { exit(1) }
print("launcher dead renderer policy: ok")
`;

const dir = mkdtempSync(join(tmpdir(), 'launcher-dead-renderer-'));
try {
  writeFileSync(join(dir, 'main.swift'), driver);
  const build = spawnSync('xcrun', ['swiftc', join(dir, 'main.swift'), '-o', join(dir, 'policy')], {encoding: 'utf8'});
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(join(dir, 'policy'), [], {encoding: 'utf8'});
  process.stdout.write(run.stdout);
  assert.equal(run.status, 0, run.stderr || run.stdout);
} finally {
  rmSync(dir, {recursive: true, force: true});
}
