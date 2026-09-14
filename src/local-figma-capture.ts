import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

const WINDOW_HELPER_SOURCE = String.raw`
import Cocoa
import CoreGraphics

func normalize(_ value: String) -> String {
  let scalars = value.unicodeScalars.drop { !CharacterSet.alphanumerics.contains($0) }
  let stripped = String(String.UnicodeScalarView(scalars))
  return stripped.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

let wanted = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let target = normalize(wanted)
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  fputs("Could not enumerate macOS windows\n", stderr); exit(2)
}
let figmaWindows = rows.compactMap { row -> [String: Any]? in
  guard (row[kCGWindowOwnerName as String] as? String) == "Figma",
        (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
        let number = row[kCGWindowNumber as String] as? NSNumber else { return nil }
  let name = row[kCGWindowName as String] as? String ?? ""
  return ["id": number.intValue, "name": name]
}
let namedMatch = target.isEmpty ? figmaWindows.first : figmaWindows.first { row in
  let name = normalize(row["name"] as? String ?? "")
  return name == target || name.contains(target) || target.contains(name)
}
// macOS hides window titles from background processes until Screen Recording
// permission is granted. A single Figma window is still unambiguous.
let match = namedMatch ?? (figmaWindows.count == 1 ? figmaWindows.first : nil)
guard let window = match else {
  fputs("No local Figma window matches project: \(wanted)\n", stderr); exit(3)
}
let data = try JSONSerialization.data(withJSONObject: window)
print(String(data: data, encoding: .utf8)!)
`;

let helperPromise: Promise<string> | null = null;

async function localWindowHelper(): Promise<string> {
  // Compare-and-swap on the memo. The cached value is a $TMPDIR path that macOS
  // can purge, so it is re-checked on every call — and when it is gone, only the
  // caller that still sees the dead promise replaces it, synchronously, so any
  // caller arriving meanwhile joins that one rebuild instead of starting its
  // own. Two viewers opening together after a purge otherwise ran two swiftc
  // builds (up to 98s each here) racing to rename onto the same path.
  for (;;) {
    const current = helperPromise;
    if (!current) {
      helperPromise = buildHelper();
      continue;
    }
    const cached = await current.catch(() => null);
    if (cached) {
      try {
        await access(cached, fsConstants.X_OK);
        return cached;
      } catch {}
    }
    if (helperPromise === current) {
      if (cached) console.error(`[Helper] cached binary vanished (${cached}) — rebuilding`);
      helperPromise = null;
    }
  }
}

function buildHelper(): Promise<string> {
  const promise = (async () => {
    const hash = createHash("sha256").update(WINDOW_HELPER_SOURCE).digest("hex").slice(0, 12);
    const helperPath = join(tmpdir(), `talk-to-figma-window-${hash}`);
    try {
      await access(helperPath, fsConstants.X_OK);
      return helperPath;
    } catch {}
    const buildDir = await mkdtemp(join(tmpdir(), "talk-to-figma-window-build-"));
    const sourcePath = join(buildDir, "main.swift");
    const outputPath = join(buildDir, "window-helper");
    try {
      await writeFile(sourcePath, WINDOW_HELPER_SOURCE, "utf8");
      await execFileAsync("/usr/bin/swiftc", [sourcePath, "-O", "-o", outputPath]);
      await chmod(outputPath, 0o755);
      await rename(outputPath, helperPath);
      return helperPath;
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  })();
  // A failed build must not be cached either, or one bad swiftc run disables
  // the JPEG preview until the relay restarts.
  promise.catch(() => { if (helperPromise === promise) helperPromise = null; });
  return promise;
}

export async function captureLocalFigmaWindow(
  projectName?: string,
  maxDimension = 1400,
): Promise<LocalFigmaCapture> {
  if (process.platform !== "darwin") {
    throw new Error("Local Figma window capture is currently supported on macOS only");
  }
  let windowInfo: { id: number; name: string };
  try {
    const { stdout } = await execFileAsync(await localWindowHelper(), [projectName || ""], { maxBuffer: 1024 * 1024 });
    windowInfo = JSON.parse(stdout.trim());
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(detail || `No local Figma window matches project: ${projectName || "current"}`);
  }
  const captureDir = await mkdtemp(join(tmpdir(), "talk-to-figma-preview-"));
  const capturePath = join(captureDir, "figma-window.jpg");
  try {
    try {
      await execFileAsync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowInfo.id}`, "-tjpg", capturePath]);
    } catch {
      throw new Error("Could not capture the local Figma window. Grant Screen Recording permission to the Bun/relay process and keep the Figma window visible.");
    }
    const { stdout: originalDimensions } = await execFileAsync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", capturePath]);
    const originalWidth = Number(originalDimensions.match(/pixelWidth:\s*(\d+)/)?.[1]) || maxDimension;
    const originalHeight = Number(originalDimensions.match(/pixelHeight:\s*(\d+)/)?.[1]) || maxDimension;
    if (Math.max(originalWidth, originalHeight) > Math.max(320, maxDimension)) {
      await execFileAsync("/usr/bin/sips", ["-Z", String(Math.max(320, maxDimension)), capturePath]);
    }
    const { stdout: dimensions } = await execFileAsync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", capturePath]);
    const pixelWidth = Number(dimensions.match(/pixelWidth:\s*(\d+)/)?.[1]) || originalWidth;
    const pixelHeight = Number(dimensions.match(/pixelHeight:\s*(\d+)/)?.[1]) || originalHeight;
    return {
      bytes: await readFile(capturePath),
      mimeType: "image/jpeg",
      windowName: windowInfo.name || projectName || "Figma",
      width: pixelWidth,
      height: pixelHeight,
      capturedAt: Date.now(),
    };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}
