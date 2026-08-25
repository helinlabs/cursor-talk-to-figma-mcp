import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LocalFigmaCapture {
  bytes: Buffer;
  mimeType: "image/jpeg";
  windowName: string;
  width: number;
  height: number;
  capturedAt: number;
}

const WINDOW_SCRIPT = `
function run(argv) {
  const wanted = String(argv[0] || "");
  const normalize = (value) => String(value || "").replace(/^[^A-Za-z0-9가-힣]+/, "").trim().toLowerCase();
  const target = normalize(wanted);
  const systemEvents = Application("System Events");
  const process = systemEvents.processes.byName("Figma");
  if (!process.exists()) throw new Error("Figma application is not running on this Mac");
  const windows = process.windows().map((window) => ({
    name: String(window.name() || ""),
    position: window.position(),
    size: window.size(),
  }));
  const match = target
    ? windows.find((window) => {
        const name = normalize(window.name);
        return name === target || name.includes(target) || target.includes(name);
      })
    : windows[0];
  if (!match) throw new Error("No local Figma window matches project: " + wanted);
  return JSON.stringify(match);
}`;

export async function captureLocalFigmaWindow(
  projectName?: string,
  maxDimension = 1400,
): Promise<LocalFigmaCapture> {
  if (process.platform !== "darwin") {
    throw new Error("Local Figma window capture is currently supported on macOS only");
  }
  const { stdout } = await execFileAsync("/usr/bin/osascript", [
    "-l", "JavaScript", "-e", WINDOW_SCRIPT, projectName || "",
  ], { maxBuffer: 1024 * 1024 });
  const windowInfo = JSON.parse(stdout.trim()) as { name: string; position: [number, number]; size: [number, number] };
  const [x, y] = windowInfo.position.map((value) => Math.round(value)) as [number, number];
  const [width, height] = windowInfo.size.map((value) => Math.max(1, Math.round(value))) as [number, number];
  const captureDir = await mkdtemp(join(tmpdir(), "talk-to-figma-preview-"));
  const capturePath = join(captureDir, "figma-window.jpg");
  try {
    try {
      await execFileAsync("/usr/sbin/screencapture", ["-x", `-R${x},${y},${width},${height}`, "-tjpg", capturePath]);
    } catch {
      throw new Error("Could not capture the local Figma window. Grant Screen Recording permission to the Bun/relay process and keep the Figma window visible.");
    }
    const scale = Math.min(1, Math.max(320, maxDimension) / Math.max(width, height));
    if (scale < 1) {
      await execFileAsync("/usr/bin/sips", ["-Z", String(Math.round(Math.max(width, height) * scale)), capturePath]);
    }
    return {
      bytes: await readFile(capturePath),
      mimeType: "image/jpeg",
      windowName: windowInfo.name,
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      capturedAt: Date.now(),
    };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}
