// The launcher's link-down decision, compiled and run for real.
//
// The launcher is one Swift file run straight from source on the fleet macs,
// so its pure decisions live between `>>> link-policy` / `<<< link-policy`
// markers and this test compiles exactly that block with a small driver. It
// needs swiftc, i.e. macOS; elsewhere (the Linux CI runner) it says so and
// passes, which is the same coverage the launcher had before.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const swiftc = spawnSync('xcrun', ['--find', 'swiftc'], {encoding: 'utf8'});
if (process.platform !== 'darwin' || swiftc.status !== 0) {
  console.log('launcher link policy: skipped (needs swiftc on macOS)');
  process.exit(0);
}

const source = readFileSync(new URL('../skills/figma-product-mcp/scripts/figma_product_mcp.swift', import.meta.url), 'utf8');
const begin = source.indexOf('// >>> link-policy');
const end = source.indexOf('// <<< link-policy');
assert.ok(begin >= 0 && end > begin, 'link-policy markers missing from the launcher');
const block = source.slice(begin, end);

const driver = String.raw`
import Foundation
${block}
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

let figmaError = "Unable to establish connection to Figma after 10 seconds. Please check your internet connection."
let down = classifyLinkVerdict(["ok": false, "ms": 10400, "error": figmaError])
let up = classifyLinkVerdict(["ok": true, "ms": 210])
let timedOut = classifyLinkVerdict(["ok": false, "timeout": true, "ms": 15000, "error": "no answer in 15000ms"])
let other = classifyLinkVerdict(["ok": false, "ms": 5, "error": "Unknown command"])
check(down.isDown, "Figma's connection error is down")
if case .up(let ms) = up { check(ms == 210, "up keeps ms") } else { check(false, "ok is up") }
check(!timedOut.isDown, "a local deadline is not a verdict")
check(!other.isDown, "another error is not a verdict")

check(linkRepairDecision([down, down], required: 2, load: 0) == .repair, "two downs, idle: repair")
check(linkRepairDecision([down, down], required: 2, load: 1) == .busy, "two downs, busy: held")
check(linkRepairDecision([down], required: 2, load: 0) == .inconclusive, "one down is not enough")
check(linkRepairDecision([down, timedOut], required: 2, load: 0) == .inconclusive, "a timeout breaks the streak")
check(linkRepairDecision([down, up], required: 2, load: 0) == .linked, "any answer means linked")
check(linkRepairDecision([up], required: 2, load: 5) == .linked, "linked whatever the load")
check(linkRepairDecision([], required: 2, load: 0) == .inconclusive, "no probes, no repair")

check(asksAboutUnsavedWork(texts: ["You have unsaved changes"], buttons: ["Cancel", "Close"]), "unsaved text")
check(asksAboutUnsavedWork(texts: [], buttons: ["Don’t Save", "Cancel"]), "discard button")
check(asksAboutUnsavedWork(texts: ["저장되지 않은 변경 사항이 있습니다"], buttons: ["취소"]), "Korean prompt")
check(!asksAboutUnsavedWork(texts: ["GW_Product – Figma", "Layers"], buttons: ["Share", "Present"]), "a design window is not a prompt")
check(cancelButtonIndex(["Don't save", "Cancel"]) == 1, "finds Cancel")
check(cancelButtonIndex(["Don't save", "취소"]) == 1, "finds 취소")
check(cancelButtonIndex(["Don't save", "Discard"]) == nil, "never picks a discard button as Cancel")

if failures > 0 { exit(1) }
print("launcher link policy: ok")
`;

const dir = mkdtempSync(join(tmpdir(), 'launcher-link-'));
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
