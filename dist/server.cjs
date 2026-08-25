#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/talk_to_figma_mcp/server.ts
var import_mcp = require("@modelcontextprotocol/sdk/server/mcp.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_streamableHttp = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");
var import_zod = require("zod");
var import_ws = __toESM(require("ws"), 1);
var import_uuid = require("uuid");
var fs5 = __toESM(require("fs"), 1);
var path5 = __toESM(require("path"), 1);
var os5 = __toESM(require("os"), 1);
var import_http = require("http");

// src/local-figma-capture.ts
var import_node_child_process = require("child_process");
var import_node_crypto = require("crypto");
var import_promises = require("fs/promises");
var import_node_fs = require("fs");
var import_node_os = require("os");
var import_node_path = require("path");
var import_node_util = require("util");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var WINDOW_HELPER_SOURCE = String.raw`
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
var helperPromise = null;
async function localWindowHelper() {
  if (helperPromise) return helperPromise;
  helperPromise = (async () => {
    const hash = (0, import_node_crypto.createHash)("sha256").update(WINDOW_HELPER_SOURCE).digest("hex").slice(0, 12);
    const helperPath = (0, import_node_path.join)((0, import_node_os.tmpdir)(), `talk-to-figma-window-${hash}`);
    try {
      await (0, import_promises.access)(helperPath, import_node_fs.constants.X_OK);
      return helperPath;
    } catch {
    }
    const buildDir = await (0, import_promises.mkdtemp)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "talk-to-figma-window-build-"));
    const sourcePath = (0, import_node_path.join)(buildDir, "main.swift");
    const outputPath = (0, import_node_path.join)(buildDir, "window-helper");
    try {
      await (0, import_promises.writeFile)(sourcePath, WINDOW_HELPER_SOURCE, "utf8");
      await execFileAsync("/usr/bin/swiftc", [sourcePath, "-O", "-o", outputPath]);
      await (0, import_promises.chmod)(outputPath, 493);
      await (0, import_promises.rename)(outputPath, helperPath);
      return helperPath;
    } finally {
      await (0, import_promises.rm)(buildDir, { recursive: true, force: true });
    }
  })();
  return helperPromise;
}
async function captureLocalFigmaWindow(projectName, maxDimension = 1400) {
  if (process.platform !== "darwin") {
    throw new Error("Local Figma window capture is currently supported on macOS only");
  }
  let windowInfo;
  try {
    const { stdout } = await execFileAsync(await localWindowHelper(), [projectName || ""], { maxBuffer: 1024 * 1024 });
    windowInfo = JSON.parse(stdout.trim());
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(detail || `No local Figma window matches project: ${projectName || "current"}`);
  }
  const captureDir = await (0, import_promises.mkdtemp)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "talk-to-figma-preview-"));
  const capturePath = (0, import_node_path.join)(captureDir, "figma-window.jpg");
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
      bytes: await (0, import_promises.readFile)(capturePath),
      mimeType: "image/jpeg",
      windowName: windowInfo.name || projectName || "Figma",
      width: pixelWidth,
      height: pixelHeight,
      capturedAt: Date.now()
    };
  } finally {
    await (0, import_promises.rm)(captureDir, { recursive: true, force: true });
  }
}

// src/shared/annotations-store.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
var ANNOTATIONS_FILE = path.join(
  os.homedir(),
  ".talk-to-figma",
  "index",
  "annotations.json"
);
function normalizeKeywordKey(keyword) {
  return keyword.toLowerCase().replace(/\s+/g, "");
}
function loadSearchAnnotations() {
  try {
    const raw = JSON.parse(fs.readFileSync(ANNOTATIONS_FILE, "utf8"));
    if (Array.isArray(raw?.annotations)) {
      return raw.annotations.filter(
        (a) => a && typeof a.keywordKey === "string" && typeof a.projectKey === "string" && typeof a.nodeId === "string"
      );
    }
  } catch (error) {
  }
  return [];
}
function saveSearchAnnotations(annotations) {
  const dir = path.dirname(ANNOTATIONS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.annotations.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ annotations }, null, 2));
  fs.renameSync(tmp, ANNOTATIONS_FILE);
}
function upsertSearchAnnotation(input) {
  const annotations = loadSearchAnnotations();
  const keywordKey = normalizeKeywordKey(input.keyword);
  const annotation = {
    keyword: input.keyword,
    keywordKey,
    projectKey: input.projectKey,
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    ...input.note ? { note: input.note } : {},
    addedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const idx = annotations.findIndex(
    (a) => a.keywordKey === keywordKey && a.projectKey === input.projectKey && a.nodeId === input.nodeId
  );
  if (idx !== -1) annotations[idx] = annotation;
  else annotations.push(annotation);
  saveSearchAnnotations(annotations);
  return annotation;
}
function removeSearchAnnotations(input) {
  const annotations = loadSearchAnnotations();
  const keywordKey = normalizeKeywordKey(input.keyword);
  const kept = annotations.filter(
    (a) => !(a.keywordKey === keywordKey && a.projectKey === input.projectKey && (!input.nodeId || a.nodeId === input.nodeId))
  );
  const removed = annotations.length - kept.length;
  if (removed > 0) saveSearchAnnotations(kept);
  return removed;
}
function findAnnotationsForKeys(projectKey, keys) {
  if (!keys.length) return [];
  const keySet = new Set(keys);
  return loadSearchAnnotations().filter(
    (a) => a.projectKey === projectKey && keySet.has(a.keywordKey)
  );
}

// src/shared/search-index.ts
var fs2 = __toESM(require("fs"), 1);
var path2 = __toESM(require("path"), 1);
var os2 = __toESM(require("os"), 1);
var INDEX_DIR = path2.join(os2.homedir(), ".talk-to-figma", "index");
function sanitizeKey(projectKey) {
  return projectKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
function projectIndexPath(projectKey) {
  return path2.join(INDEX_DIR, `project-${sanitizeKey(projectKey)}.json`);
}
function loadProjectIndex(projectKey) {
  try {
    const raw = JSON.parse(fs2.readFileSync(projectIndexPath(projectKey), "utf8"));
    if (raw && typeof raw.projectKey === "string" && Array.isArray(raw.pages)) {
      return raw;
    }
  } catch (error) {
  }
  return null;
}
function findNormalizedMatch(haystack, qLower, qLowerNoSpace) {
  const lower = haystack.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx !== -1) return { start: idx, end: idx + qLower.length };
  if (!qLowerNoSpace) return null;
  const map = [];
  let stripped = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (!/\s/.test(ch)) {
      stripped += ch;
      map.push(i);
    }
  }
  const sIdx = stripped.indexOf(qLowerNoSpace);
  if (sIdx === -1) return null;
  return { start: map[sIdx], end: map[sIdx + qLowerNoSpace.length - 1] + 1 };
}
function textMatchSnippet(characters, range) {
  if (!range) return null;
  const start = Math.max(0, range.start - 40);
  const end = Math.min(characters.length, range.end + 40);
  return (start > 0 ? "\u2026" : "") + characters.slice(start, end) + (end < characters.length ? "\u2026" : "");
}
function buildNeedles(queries) {
  const needles = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of queries) {
    const qLower = raw.toLowerCase();
    const qLowerNoSpace = qLower.replace(/\s+/g, "");
    if (!qLowerNoSpace || seen.has(qLowerNoSpace)) continue;
    seen.add(qLowerNoSpace);
    needles.push({ raw, qLower, qLowerNoSpace });
  }
  return needles;
}

// src/shared/project-context.ts
var fs3 = __toESM(require("fs"), 1);
var path3 = __toESM(require("path"), 1);
var os3 = __toESM(require("os"), 1);
var CONTEXT_DIR = path3.join(os3.homedir(), ".talk-to-figma", "context");
function sanitizeKey2(projectKey) {
  return projectKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
function projectContextCachePath(projectKey) {
  return path3.join(CONTEXT_DIR, `${sanitizeKey2(projectKey)}.json`);
}
function loadCachedProjectContext(projectKey) {
  try {
    const raw = JSON.parse(fs3.readFileSync(projectContextCachePath(projectKey), "utf8"));
    if (raw && typeof raw.content === "string") {
      return {
        content: raw.content,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
        updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : null,
        cachedAt: typeof raw.cachedAt === "string" ? raw.cachedAt : ""
      };
    }
  } catch {
  }
  return null;
}
function cacheProjectContext(projectKey, record) {
  try {
    fs3.mkdirSync(CONTEXT_DIR, { recursive: true });
    const file = projectContextCachePath(projectKey);
    const tmp = path3.join(
      CONTEXT_DIR,
      `.${sanitizeKey2(projectKey)}.${process.pid}.${Date.now()}.tmp`
    );
    const payload = {
      content: record.content,
      updatedAt: record.updatedAt ?? null,
      ...record.updatedBy ? { updatedBy: record.updatedBy } : {},
      cachedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    fs3.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs3.renameSync(tmp, file);
  } catch {
  }
}
function clearCachedProjectContext(projectKey) {
  try {
    fs3.rmSync(projectContextCachePath(projectKey), { force: true });
  } catch {
  }
}
function hasCachedProjectContext(projectKey) {
  const cached = loadCachedProjectContext(projectKey);
  return !!cached && cached.content.trim().length > 0;
}

// src/shared/errors-store.ts
var fs4 = __toESM(require("fs"), 1);
var path4 = __toESM(require("path"), 1);
var os4 = __toESM(require("os"), 1);
var ERRORS_FILE = path4.join(os4.homedir(), ".talk-to-figma", "errors.json");
var MAX_ENTRIES = 500;
var VALID_SOURCES = /* @__PURE__ */ new Set(["indexer", "command", "script", "relay"]);
function loadRaw() {
  try {
    const raw = JSON.parse(fs4.readFileSync(ERRORS_FILE, "utf8"));
    if (Array.isArray(raw?.errors)) {
      return raw.errors.filter(
        (e) => e && typeof e.ts === "string" && typeof e.message === "string" && VALID_SOURCES.has(e.source)
      );
    }
  } catch {
  }
  return [];
}
function loadRelayErrors(opts) {
  let errors = loadRaw().slice().reverse();
  if (opts?.source) errors = errors.filter((e) => e.source === opts.source);
  const limit = Math.max(1, Math.min(Number(opts?.limit) || 100, MAX_ENTRIES));
  return errors.slice(0, limit);
}

// src/shared/version.ts
var PROTOCOL_VERSION = "2.5.5";
function protocolMajor(version) {
  if (typeof version !== "string") return null;
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) ? major : null;
}

// src/talk_to_figma_mcp/server.ts
var BINARY_MAGIC = Buffer.from([84, 84, 70, 66]);
function rawDataToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map(rawDataToBuffer));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}
function decodeBinaryFrame(data) {
  const raw = rawDataToBuffer(data);
  if (raw.byteLength < 8 || !raw.subarray(0, 4).equals(BINARY_MAGIC)) {
    throw new Error("Invalid Talk-to-Figma binary frame");
  }
  const headerLength = raw.readUInt32BE(4);
  if (headerLength <= 0 || 8 + headerLength > raw.byteLength) {
    throw new Error("Invalid Talk-to-Figma binary header length");
  }
  const envelope = JSON.parse(raw.subarray(8, 8 + headerLength).toString("utf8"));
  return { envelope, payload: raw.subarray(8 + headerLength) };
}
var logger = {
  info: (message) => process.stderr.write(`[INFO] ${message}
`),
  debug: (message) => process.stderr.write(`[DEBUG] ${message}
`),
  warn: (message) => process.stderr.write(`[WARN] ${message}
`),
  error: (message) => process.stderr.write(`[ERROR] ${message}
`),
  log: (message) => process.stderr.write(`[LOG] ${message}
`)
};
var STATE_DIR = path5.join(os5.homedir(), ".talk-to-figma");
var STATE_FILE = path5.join(STATE_DIR, "state.json");
function loadPersistedSelectedProject() {
  try {
    const raw = JSON.parse(fs5.readFileSync(STATE_FILE, "utf8"));
    const project = raw?.selectedProject;
    if (project && typeof project === "object" && typeof project.name === "string") {
      return {
        projectKey: String(project.projectKey || ""),
        name: project.name,
        fileKey: project.fileKey ?? null
      };
    }
  } catch (error) {
  }
  return null;
}
function persistSelectedProject(project) {
  try {
    fs5.mkdirSync(STATE_DIR, { recursive: true });
    fs5.writeFileSync(STATE_FILE, JSON.stringify({ selectedProject: project }, null, 2));
  } catch (error) {
    logger.warn(`Could not persist selected project: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function createMcpServer(options = {}) {
  let ws = null;
  let disposed = false;
  let reconnectTimer;
  let heartbeatTimer;
  const pendingRequests = /* @__PURE__ */ new Map();
  let currentChannel = null;
  let desiredChannel = null;
  let selectedProject = loadPersistedSelectedProject();
  let fatalProtocolError = null;
  const requesterId = process.env.TALK_TO_FIGMA_REQUESTER_ID || process.env.CODEX_THREAD_ID || process.env.CURSOR_SESSION_ID || `mcp-${process.pid}`;
  const bulkJobs = /* @__PURE__ */ new Map();
  const server = new import_mcp.McpServer({
    name: "TalkToFigmaMCP",
    version: PROTOCOL_VERSION
  });
  const args = process.argv.slice(2);
  const serverArg = args.find((arg) => arg.startsWith("--server="));
  const serverUrl = serverArg ? serverArg.slice("--server=".length) : "localhost";
  function normalizeRelayWebSocketUrl(value) {
    const target = value.trim() || "localhost";
    if (target === "localhost") return "ws://localhost:3055";
    if (/^wss?:\/\//i.test(target)) return target;
    if (/^https?:\/\//i.test(target)) return target.replace(/^http/i, "ws");
    return `wss://${target}`;
  }
  const RELAY_WS_URL = normalizeRelayWebSocketUrl(serverUrl);
  function relayHttpUrl(endpoint) {
    const url = new URL(RELAY_WS_URL);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    return url.toString();
  }
  async function saveToRelayGallery(bytes, suggestedName, extension) {
    const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const response = await fetch(relayHttpUrl("exports"), {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Figma-Export-Name": encodeURIComponent(suggestedName),
        "X-Figma-Export-Extension": extension
      },
      body
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Gallery upload failed with HTTP ${response.status}`);
    return result;
  }
  server.tool(
    "get_document_info",
    "Get information about a Figma page: its top-level nodes plus a list of all pages in the file (so non-open pages are discoverable). Pass `pageId` to inspect a specific page without switching to it. If you know (part of) the name of what you're looking for, use search_nodes first instead of inspecting pages one by one; for a one-call overview of all pages use get_file_outline.",
    {
      pageId: import_zod.z.string().optional().describe("Inspect this page instead of the current one (see list_pages for ids).")
    },
    async ({ pageId }) => {
      try {
        const result = await sendCommandToFigma("get_document_info", { pageId });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting document info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_selection",
    "Get information about the current selection in Figma",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_selection");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting selection: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "read_my_design",
    "Get detailed information about the current selection in Figma, including all node details",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("read_my_design", {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_node_info",
    "Get detailed information about a specific node in Figma. For large/deep nodes, pass `fields` to return only the properties you need and/or `maxDepth` to limit how deep the child tree is expanded (a 900K-char section becomes a few KB). When children are omitted (depth/field limit) a `childCount` is included so you know to drill deeper.",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to get information about"),
      fields: import_zod.z.array(import_zod.z.string()).optional().describe("Only return these top-level fields (id/name/type are always included). e.g. ['fills','characters','style','absoluteBoundingBox','componentProperties','children']. Omit 'children' to get just this node."),
      maxDepth: import_zod.z.number().int().min(0).optional().describe("Max levels of children to expand. 0 = this node only, 1 = direct children, etc. Omit for the full subtree."),
      includeHash: import_zod.z.boolean().optional().describe("Also return a stable `subtreeHash` covering the subtree's structure, text, bound tokens, and sizes. Same content \u2192 same hash; useful for detecting which screens changed between runs.")
    },
    async ({ nodeId, fields, maxDepth, includeHash }) => {
      try {
        const result = await sendCommandToFigma("get_node_info", { nodeId, fields, maxDepth, includeHash });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_nodes_info",
    "Get detailed information about multiple nodes in Figma. Supports the same `fields` / `maxDepth` shaping as get_node_info to keep responses small.",
    {
      nodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of node IDs to get information about"),
      fields: import_zod.z.array(import_zod.z.string()).optional().describe("Only return these top-level fields (id/name/type always included)."),
      maxDepth: import_zod.z.number().int().min(0).optional().describe("Max levels of children to expand (0 = node only)."),
      includeHash: import_zod.z.boolean().optional().describe("Also return a stable `subtreeHash` per node (see get_node_info).")
    },
    async ({ nodeIds, fields, maxDepth, includeHash }) => {
      try {
        const results = await Promise.all(
          nodeIds.map(async (nodeId) => {
            const result = await sendCommandToFigma("get_node_info", { nodeId, fields, maxDepth, includeHash });
            return { nodeId, info: result };
          })
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_frame_context",
    "Get a single, pruned, RN-ready digest of a frame's subtree \u2014 replaces the get_node_info + scan_text_nodes + get_nodes_design_info round-trips. OS chrome (Status Bar / Home Indicator / Keyboard / Notch / Dynamic Island) and hidden nodes are dropped; each remaining node carries only relative bounds, text + typography, flex-friendly layout (flexDirection/gap/padding/justify/align), resolved semantic tokens (fill/stroke/radius/textStyle\u2026), and a hasImageFill flag. Call it on a screen frame and write the spec from the one response. For very deep/large screens, pass `maxDepth` to cap traversal \u2014 nodes cut off by the limit still appear but carry `childCount` + `truncated: true` so you can drill into them with a follow-up call.",
    {
      nodeId: import_zod.z.string().describe("The ID of the frame/screen node to digest"),
      excludeChrome: import_zod.z.boolean().optional().describe("Drop OS chrome + hidden nodes (default true). Set false to keep everything."),
      chromeNames: import_zod.z.array(import_zod.z.string()).optional().describe("Override the default chrome name list (case-insensitive substring match)."),
      includeHash: import_zod.z.boolean().optional().describe("Also include a stable `subtreeHash` at the root for change detection."),
      maxDepth: import_zod.z.number().int().min(0).optional().describe("Max levels of children to digest. 0 = root only, 1 = direct children, etc. Omit for the full subtree. Use this when a deep screen makes the response too large or times out.")
    },
    async ({ nodeId, excludeChrome, chromeNames, includeHash, maxDepth }) => {
      try {
        const result = await sendCommandToFigma("get_frame_context", {
          nodeId,
          excludeChrome: excludeChrome === void 0 ? true : excludeChrome,
          chromeNames,
          includeHash: !!includeHash,
          maxDepth
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting frame context: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "create_rectangle",
    "Create a new rectangle in Figma",
    {
      x: import_zod.z.number().describe("X position"),
      y: import_zod.z.number().describe("Y position"),
      width: import_zod.z.number().describe("Width of the rectangle"),
      height: import_zod.z.number().describe("Height of the rectangle"),
      name: import_zod.z.string().optional().describe("Optional name for the rectangle"),
      parentId: import_zod.z.string().optional().describe("Optional parent node ID to append the rectangle to")
    },
    async ({ x, y, width, height, name, parentId }) => {
      try {
        const result = await sendCommandToFigma("create_rectangle", {
          x,
          y,
          width,
          height,
          name: name || "Rectangle",
          parentId
        });
        return {
          content: [
            {
              type: "text",
              text: `Created rectangle "${JSON.stringify(result)}"`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "create_frame",
    "Create a new frame in Figma",
    {
      x: import_zod.z.number().describe("X position"),
      y: import_zod.z.number().describe("Y position"),
      width: import_zod.z.number().describe("Width of the frame"),
      height: import_zod.z.number().describe("Height of the frame"),
      name: import_zod.z.string().optional().describe("Optional name for the frame"),
      parentId: import_zod.z.string().optional().describe("Optional parent node ID to append the frame to"),
      fillColor: import_zod.z.object({
        r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
        g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
        b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
      }).optional().describe("Fill color in RGBA format"),
      strokeColor: import_zod.z.object({
        r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
        g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
        b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
      }).optional().describe("Stroke color in RGBA format"),
      strokeWeight: import_zod.z.number().positive().optional().describe("Stroke weight"),
      layoutMode: import_zod.z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
      layoutWrap: import_zod.z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
      paddingTop: import_zod.z.number().optional().describe("Top padding for auto-layout frame"),
      paddingRight: import_zod.z.number().optional().describe("Right padding for auto-layout frame"),
      paddingBottom: import_zod.z.number().optional().describe("Bottom padding for auto-layout frame"),
      paddingLeft: import_zod.z.number().optional().describe("Left padding for auto-layout frame"),
      primaryAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional().describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
      counterAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
      layoutSizingHorizontal: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
      layoutSizingVertical: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
      itemSpacing: import_zod.z.number().optional().describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
    },
    async ({
      x,
      y,
      width,
      height,
      name,
      parentId,
      fillColor,
      strokeColor,
      strokeWeight,
      layoutMode,
      layoutWrap,
      paddingTop,
      paddingRight,
      paddingBottom,
      paddingLeft,
      primaryAxisAlignItems,
      counterAxisAlignItems,
      layoutSizingHorizontal,
      layoutSizingVertical,
      itemSpacing
    }) => {
      try {
        const result = await sendCommandToFigma("create_frame", {
          x,
          y,
          width,
          height,
          name: name || "Frame",
          parentId,
          fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
          strokeColor,
          strokeWeight,
          layoutMode,
          layoutWrap,
          paddingTop,
          paddingRight,
          paddingBottom,
          paddingLeft,
          primaryAxisAlignItems,
          counterAxisAlignItems,
          layoutSizingHorizontal,
          layoutSizingVertical,
          itemSpacing
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating frame: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "create_text",
    "Create a new text element in Figma",
    {
      x: import_zod.z.number().describe("X position"),
      y: import_zod.z.number().describe("Y position"),
      text: import_zod.z.string().describe("Text content"),
      fontSize: import_zod.z.number().optional().describe("Font size (default: 14)"),
      fontWeight: import_zod.z.number().optional().describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
      fontColor: import_zod.z.object({
        r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
        g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
        b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
      }).optional().describe("Font color in RGBA format"),
      name: import_zod.z.string().optional().describe("Semantic layer name for the text node"),
      parentId: import_zod.z.string().optional().describe("Optional parent node ID to append the text to")
    },
    async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }) => {
      try {
        const result = await sendCommandToFigma("create_text", {
          x,
          y,
          text,
          fontSize: fontSize || 14,
          fontWeight: fontWeight || 400,
          fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
          name: name || "Text",
          parentId
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating text: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_fill_color",
    "Set the fill color of a node in Figma can be TextNode or FrameNode",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to modify"),
      r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
      g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
      b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
      a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)")
    },
    async ({ nodeId, r, g, b, a }) => {
      try {
        const result = await sendCommandToFigma("set_fill_color", {
          nodeId,
          color: { r, g, b, a: a || 1 }
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Set fill color of node "${typedResult.name}" to RGBA(${r}, ${g}, ${b}, ${a || 1})`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_image_fill_from_node",
    "Swap the picture inside another node: exports `sourceNodeId` as PNG and puts it in `targetNodeId`'s IMAGE fill. Both steps run inside the plugin, so no image bytes cross the socket (a screenshot is megabytes \u2014 base64 over the relay hits message limits). **Geometry is inherited, not rebuilt.** If the target already has an IMAGE fill, only its `imageHash` changes \u2014 `scaleMode`, `imageTransform`, rotation and filters are kept. That matters for device mockups: the screen slot is an axis-aligned node whose tilt lives in the paint's `imageTransform`, so building a fresh paint would leave an upright screenshot merely cropped to a slanted path, not matching the device angle. The target's own transform (rotation, masks) is untouched either way, since only `fills` is written. Typical use: drop a localized app-screen frame into a mockup's `Paste content here` slot. \u26A0\uFE0F Enumerate a mockup's children with `scan_nodes_by_types`, not `get_node_info` \u2014 mask layers are omitted from `children`, so the real content slot can be invisible there.",
    {
      sourceNodeId: import_zod.z.string().describe("Node to render (e.g. a live app-screen frame)"),
      targetNodeId: import_zod.z.string().describe("Node whose picture is replaced \u2014 the mockup's content slot, NOT its mask"),
      scale: import_zod.z.number().positive().optional().describe("Export scale for the source render (default 2). Figma rejects images over 4096px on a side, so keep width*scale and height*scale under that."),
      scaleMode: import_zod.z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Fill mode for a NEW paint. Ignored when inheriting \u2014 overriding it would make Figma drop the imageTransform and flatten a mockup's tilt. Pair with replacePaint to force it."),
      replacePaint: import_zod.z.boolean().optional().describe("Discard the existing paint instead of inheriting it. Drops imageTransform \u2014 only for slots that have no geometry to keep.")
    },
    async ({ sourceNodeId, targetNodeId, scale, scaleMode, replacePaint }) => {
      try {
        const result = await sendCommandToFigma("set_image_fill_from_node", {
          sourceNodeId,
          targetNodeId,
          scale: scale || 2,
          scaleMode,
          replacePaint: replacePaint || false
        });
        const typed = result;
        const geom = typed.inheritedGeometry ? `inherited ${typed.inheritedGeometry.scaleMode}${typed.inheritedGeometry.hasImageTransform ? " + imageTransform" : ""}` : "new paint (no geometry inherited \u2014 check the device angle)";
        return {
          content: [
            {
              type: "text",
              text: `Swapped "${typed.sourceName}" into "${typed.targetName}" (${typed.bytes} bytes, ${typed.scaleMode}, ${geom}).`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting image fill: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_node_geometry",
    "Read a node's size, rotation, vector vertices and existing image-fill geometry. Use it to get the four corners of a device mockup's slanted screen slot (a 4-point VECTOR, often named 'Paste content here') \u2014 `get_node_info` does not return vector paths. Coordinates come back in NODE-LOCAL space (0..width, 0..height), the same space an image fill is painted into, so a quad warped to those points drops straight in.",
    {
      nodeId: import_zod.z.string().describe("Node to measure \u2014 usually the mockup's screen slot vector")
    },
    async ({ nodeId }) => {
      try {
        const result = await sendCommandToFigma("get_node_geometry", { nodeId });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error reading geometry: ${error instanceof Error ? error.message : String(error)}` }]
        };
      }
    }
  );
  server.tool(
    "set_image_fill_from_bytes",
    "Put an already-prepared PNG (base64) into a node's IMAGE fill. **Figma cannot skew**, so a screenshot that has to match a tilted device must be perspective-warped OUTSIDE Figma (PIL/OpenCV) \u2014 this is how the result gets back in. `set_image_fill_from_node` bakes inside the plugin and therefore cannot warp; use that one for upright slots and this one for slanted mockups. Existing paint geometry is inherited (only `imageHash` changes) unless `replacePaint` is set. \u26A0\uFE0F Bytes travel over the relay \u2014 send one warped image per call, not a batch. Figma rejects images over 4096px on a side.",
    {
      nodeId: import_zod.z.string().describe("Node whose image fill is replaced"),
      imageBase64: import_zod.z.string().describe("PNG bytes, base64-encoded, already warped to the target quad"),
      scaleMode: import_zod.z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Only used when creating a new paint (no existing image fill, or replacePaint)"),
      replacePaint: import_zod.z.boolean().optional().describe("Discard the existing paint instead of inheriting it")
    },
    async ({ nodeId, imageBase64, scaleMode, replacePaint }) => {
      try {
        const result = await sendCommandToFigma("set_image_fill_from_bytes", {
          nodeId,
          imageBase64,
          scaleMode,
          replacePaint: replacePaint || false
        });
        const typed = result;
        return {
          content: [{ type: "text", text: `Filled "${typed.name}" with ${typed.bytes} bytes (${typed.scaleMode}, ${typed.inherited ? "inherited paint" : "new paint"}).` }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error setting image fill: ${error instanceof Error ? error.message : String(error)}` }]
        };
      }
    }
  );
  server.tool(
    "set_stroke_color",
    "Set the stroke color of a node in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to modify"),
      r: import_zod.z.number().min(0).max(1).describe("Red component (0-1)"),
      g: import_zod.z.number().min(0).max(1).describe("Green component (0-1)"),
      b: import_zod.z.number().min(0).max(1).describe("Blue component (0-1)"),
      a: import_zod.z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
      weight: import_zod.z.number().positive().optional().describe("Stroke weight")
    },
    async ({ nodeId, r, g, b, a, weight }) => {
      try {
        const result = await sendCommandToFigma("set_stroke_color", {
          nodeId,
          color: { r, g, b, a: a || 1 },
          weight: weight || 1
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Set stroke color of node "${typedResult.name}" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "move_node",
    "Move a node to a new position in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to move"),
      x: import_zod.z.number().describe("New X position"),
      y: import_zod.z.number().describe("New Y position")
    },
    async ({ nodeId, x, y }) => {
      try {
        const result = await sendCommandToFigma("move_node", { nodeId, x, y });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Moved node "${typedResult.name}" to position (${x}, ${y})`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error moving node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "clone_node",
    "Clone an existing node in Figma. Pass `name` to rename the clone in the same call \u2014 a clone inherits the original's name, so cloning a whole language row (DE_01..08 \u2192 IT_01..08) otherwise leaves every frame called DE_*.",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to clone"),
      x: import_zod.z.number().optional().describe("New X position for the clone"),
      y: import_zod.z.number().optional().describe("New Y position for the clone"),
      name: import_zod.z.string().optional().describe("Name for the clone (defaults to the original's name)"),
      parentId: import_zod.z.string().optional().describe("Container to append the clone to. Without it the clone lands beside the ORIGINAL \u2014 which drops a stray copy into another page/section when cloning across containers.")
    },
    async ({ nodeId, x, y, name, parentId }) => {
      try {
        const result = await sendCommandToFigma("clone_node", { nodeId, x, y, name, parentId });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== void 0 && y !== void 0 ? ` at position (${x}, ${y})` : ""}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_node_names",
    "Rename one or more nodes. Use after cloning a language row so the copies stop carrying the source language's names.",
    {
      names: import_zod.z.array(
        import_zod.z.object({
          nodeId: import_zod.z.string().describe("The ID of the node to rename"),
          name: import_zod.z.string().describe("The new layer name")
        })
      ).describe("Nodes to rename")
    },
    async ({ names }) => {
      try {
        const result = await sendCommandToFigma("set_node_names", { names });
        const typedResult = result;
        const failures = typedResult.results.filter((r) => !r.success);
        return {
          content: [
            {
              type: "text",
              text: `Renamed ${typedResult.renamed}/${typedResult.results.length} nodes` + (failures.length ? `
Failed: ${JSON.stringify(failures)}` : "")
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error renaming nodes: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "copy_image_fill",
    "Copy an IMAGE fill from one node to another, preserving imageHash and paint geometry. Use when the fill cannot be re-exported (e.g. a mask node, which exports as 1x1 transparent).",
    {
      sourceNodeId: import_zod.z.string().describe("Node to copy the IMAGE fill from"),
      targetNodeId: import_zod.z.string().describe("Node whose fills are replaced"),
      fillIndex: import_zod.z.number().optional().describe("Which IMAGE fill to take when the source has several (default 0)")
    },
    async ({ sourceNodeId, targetNodeId, fillIndex }) => {
      try {
        const result = await sendCommandToFigma("copy_image_fill", { sourceNodeId, targetNodeId, fillIndex });
        const t = result;
        return { content: [{ type: "text", text: `Copied image fill ${t.imageHash} (${t.scaleMode}) to ${targetNodeId}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error copying image fill: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "create_section",
    "Create a SECTION on the current page. Use to group a block of work without the clipping/background a FRAME would impose.",
    {
      name: import_zod.z.string().describe("Section name"),
      x: import_zod.z.number().describe("X position"),
      y: import_zod.z.number().describe("Y position"),
      width: import_zod.z.number().describe("Section width"),
      height: import_zod.z.number().describe("Section height")
    },
    async ({ name, x, y, width, height }) => {
      try {
        const r = await sendCommandToFigma("create_section", { name, x, y, width, height });
        return { content: [{ type: "text", text: `Created section "${name}" (${r.id}) at (${x}, ${y}) ${width}x${height}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error creating section: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "create_component_from_node",
    "Turn an existing node into a COMPONENT in place. Instances of it then follow edits to the master while keeping their own text overrides.",
    {
      nodeId: import_zod.z.string().describe("Node to promote"),
      name: import_zod.z.string().optional().describe("Name for the component")
    },
    async ({ nodeId, name }) => {
      try {
        const r = await sendCommandToFigma("create_component_from_node", { nodeId, name });
        return { content: [{ type: "text", text: r.alreadyComponent ? `Node ${nodeId} is already a component (${r.name})` : `Created component "${r.name}" (${r.id})` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error creating component: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_text_segments",
    "Read a text node's per-range styles (fontSize, fontName, fills, ...). Use before replacing text that mixes styles within one node.",
    { nodeId: import_zod.z.string().describe("Text node to read") },
    async ({ nodeId }) => {
      try {
        const r = await sendCommandToFigma("get_text_segments", { nodeId });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error reading text segments: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "set_text_segments",
    "Replace a text node's content while restoring per-range styles. Pass segments in order; each carries its own characters plus the style to apply.",
    {
      nodeId: import_zod.z.string().describe("Text node to write"),
      segments: import_zod.z.array(import_zod.z.object({
        characters: import_zod.z.string(),
        fontSize: import_zod.z.number().optional(),
        fontName: import_zod.z.object({ family: import_zod.z.string(), style: import_zod.z.string() }).optional(),
        fills: import_zod.z.array(import_zod.z.any()).optional(),
        lineHeight: import_zod.z.any().optional(),
        letterSpacing: import_zod.z.any().optional(),
        textCase: import_zod.z.string().optional(),
        textDecoration: import_zod.z.string().optional()
      })).describe("Ordered runs; concatenated characters become the new content")
    },
    async ({ nodeId, segments }) => {
      try {
        const r = await sendCommandToFigma("set_text_segments", { nodeId, segments });
        return { content: [{ type: "text", text: `Set ${r.segments} styled segment(s) on ${nodeId}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error setting text segments: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "mirror_horizontal",
    "Mirror a container's horizontal arrangement for RTL. Reverses child order in a horizontal auto-layout, or mirrors child x positions in an absolute container.",
    {
      nodeId: import_zod.z.string().describe("Container to mirror"),
      mode: import_zod.z.enum(["auto", "order", "position"]).optional().describe("auto (default) picks by layoutMode")
    },
    async ({ nodeId, mode }) => {
      try {
        const r = await sendCommandToFigma("mirror_horizontal", { nodeId, mode });
        return { content: [{ type: "text", text: `Mirrored ${nodeId} by ${r.mode} (${r.count} children)` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error mirroring: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "set_text_align",
    "Set a text node's horizontal/vertical alignment. Use to flip LEFT-aligned copy to RIGHT for RTL locales.",
    {
      nodeId: import_zod.z.string().describe("Text node"),
      horizontal: import_zod.z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
      vertical: import_zod.z.enum(["TOP", "CENTER", "BOTTOM"]).optional()
    },
    async ({ nodeId, horizontal, vertical }) => {
      try {
        const r = await sendCommandToFigma("set_text_align", { nodeId, horizontal, vertical });
        return { content: [{ type: "text", text: `Aligned ${nodeId}: ${r.textAlignHorizontal}/${r.textAlignVertical}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error aligning text: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "detach_instance",
    "Detach an INSTANCE into a plain frame so its children can be reordered or repositioned (e.g. for RTL mirroring).",
    { nodeId: import_zod.z.string().describe("Instance to detach") },
    async ({ nodeId }) => {
      try {
        const r = await sendCommandToFigma("detach_instance", { nodeId });
        return { content: [{ type: "text", text: r.detached ? `Detached ${nodeId} -> ${r.id}` : `${nodeId} is ${r.type}, not an instance` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error detaching: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "set_node_data",
    "Store JSON/text on a node as shared plugin data. Use to keep a single source of truth (translations, generation params) inside the Figma document itself.",
    {
      nodeId: import_zod.z.string().describe("Node to attach data to (a SECTION works well)"),
      key: import_zod.z.string().describe("Entry key, e.g. 'config' or 'listing:it'"),
      value: import_zod.z.string().describe("Serialized value (JSON string)"),
      namespace: import_zod.z.string().optional().describe("Shared namespace, default 'gymwork_aso'")
    },
    async ({ nodeId, key, value, namespace }) => {
      try {
        const r = await sendCommandToFigma("set_node_data", { nodeId, key, value, namespace });
        return { content: [{ type: "text", text: `${r.key}: ${r.bytes}B \uC800\uC7A5${r.truncated ? " \u26A0\uFE0F \uC798\uB9BC (" + r.stored + "B)" : ""}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_node_data",
    "Read shared plugin data from a node. Omit `key` to list every key and value in the namespace.",
    {
      nodeId: import_zod.z.string().describe("Node to read from"),
      key: import_zod.z.string().optional().describe("Entry key; omit to get all"),
      namespace: import_zod.z.string().optional().describe("Shared namespace, default 'gymwork_aso'")
    },
    async ({ nodeId, key, namespace }) => {
      try {
        const r = await sendCommandToFigma("get_node_data", { nodeId, key, namespace });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "delete_node_data",
    "Remove one shared plugin data entry from a node.",
    {
      nodeId: import_zod.z.string().describe("Node"),
      key: import_zod.z.string().describe("Entry key to remove"),
      namespace: import_zod.z.string().optional().describe("Shared namespace, default 'gymwork_aso'")
    },
    async ({ nodeId, key, namespace }) => {
      try {
        await sendCommandToFigma("delete_node_data", { nodeId, key, namespace });
        return { content: [{ type: "text", text: `\uC0AD\uC81C: ${key}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "resize_node",
    "Resize a node in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to resize"),
      width: import_zod.z.number().positive().describe("New width"),
      height: import_zod.z.number().positive().describe("New height")
    },
    async ({ nodeId, width, height }) => {
      try {
        const result = await sendCommandToFigma("resize_node", {
          nodeId,
          width,
          height
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error resizing node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "delete_node",
    "Delete a node from Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to delete")
    },
    async ({ nodeId }) => {
      try {
        await sendCommandToFigma("delete_node", { nodeId });
        return {
          content: [
            {
              type: "text",
              text: `Deleted node with ID: ${nodeId}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "delete_multiple_nodes",
    "Delete multiple nodes from Figma at once",
    {
      nodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of node IDs to delete")
    },
    async ({ nodeIds }) => {
      try {
        const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "export_node_as_image",
    "Export a node as an image from Figma. If `outputPath` is given, the bytes are written to that file on disk (parent dirs auto-created) and the tool returns the saved path + dimensions. Without `outputPath`, stdio mode returns the image inline while HTTP mode returns an authenticated tunnel download URL with a finite TTL. The exported SVG always carries REAL, renderable colors. For SVG, pass `includeColorTokens: true` to ALSO get `colorTokens` \u2014 the authoritative list of which color variable each paint is bound to ([{token, hex, property}] in document order) so the caller can inject its own {{token}} placeholders. (The plugin never mutates the SVG: matching hexes in SVG text is lossy \u2014 hard-coded colors collide with token colors \u2014 so token injection is left to the caller, which has the design-system context.)",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to export"),
      format: import_zod.z.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Export format (default PNG)"),
      scale: import_zod.z.number().positive().optional().describe("Export scale (raster only, default 1)"),
      outputPath: import_zod.z.string().optional().describe("If set, save the export to this file path (absolute, or relative to the server's working dir) instead of returning it inline. Parent directories are created automatically."),
      saveToGallery: import_zod.z.boolean().optional().describe("Save into the relay/MCP managed export gallery so it can be browsed and cleaned from the web dashboard"),
      includeColorTokens: import_zod.z.boolean().optional().describe("SVG only: also return `colorTokens` ([{token, hex, property}], document order) listing every paint bound to a color variable, so the caller can map resolved colors back to design tokens. The SVG itself keeps real colors.")
    },
    async ({ nodeId, format, scale, outputPath, saveToGallery, includeColorTokens }) => {
      try {
        if (options.remoteExportBase && outputPath) {
          throw new Error("outputPath is disabled in HTTP mode; omit it to receive a tunnel download URL");
        }
        const fmt = (format || "PNG").toUpperCase();
        const result = await sendCommandToFigma("export_node_as_image", {
          nodeId,
          format: fmt,
          scale: scale || 1,
          includeColorTokens: !!includeColorTokens
        });
        if (!outputPath && options.remoteExportBase) {
          const extension = fmt.toLowerCase();
          const name = `${(0, import_uuid.v4)()}.${extension}`;
          const resolved = path5.join(exportDirectory, name);
          fs5.mkdirSync(exportDirectory, { recursive: true, mode: 448 });
          if (fmt === "SVG" && typeof result.svg === "string") {
            fs5.writeFileSync(resolved, result.svg, { encoding: "utf8", mode: 384 });
          } else {
            if (!result.imageBytes) throw new Error("Figma export returned no image bytes");
            fs5.writeFileSync(resolved, Buffer.from(result.imageBytes), { mode: 384 });
          }
          const stat = fs5.statSync(resolved);
          const summary = {
            saved: true,
            url: `${options.remoteExportBase}/files/${name}`,
            expiresInHours: exportTTL / (60 * 60 * 1e3),
            nodeName: result.nodeName,
            format: fmt,
            bytes: stat.size
          };
          if (typeof result.width === "number") summary.width = result.width;
          if (typeof result.height === "number") summary.height = result.height;
          if (result.colorTokens) summary.colorTokens = result.colorTokens;
          if (result.usedTokens) summary.usedTokens = result.usedTokens;
          return { content: [{ type: "text", text: JSON.stringify(summary) }] };
        }
        if (saveToGallery && !outputPath) {
          const extension = fmt === "JPG" ? "jpg" : fmt.toLowerCase();
          const payload = fmt === "SVG" && typeof result.svg === "string" ? result.svg : result.imageBytes;
          if (!payload) throw new Error("Image payload was not received");
          const gallery = await saveToRelayGallery(payload, result.nodeName || "figma-export", extension);
          return { content: [{ type: "text", text: JSON.stringify({ ...gallery, managed: true, nodeName: result.nodeName, format: fmt }) }] };
        }
        if (outputPath) {
          const resolved = path5.resolve(outputPath);
          fs5.mkdirSync(path5.dirname(resolved), { recursive: true });
          if (fmt === "SVG" && typeof result.svg === "string") {
            fs5.writeFileSync(resolved, result.svg, "utf8");
          } else {
            if (!result.imageBytes) throw new Error("Image payload was not received");
            fs5.writeFileSync(resolved, Buffer.from(result.imageBytes));
          }
          const stat = fs5.statSync(resolved);
          const summary = {
            saved: true,
            path: resolved,
            nodeName: result.nodeName,
            format: fmt,
            bytes: stat.size
          };
          if (typeof result.width === "number") summary.width = result.width;
          if (typeof result.height === "number") summary.height = result.height;
          if (result.colorTokens) summary.colorTokens = result.colorTokens;
          if (result.usedTokens) summary.usedTokens = result.usedTokens;
          return { content: [{ type: "text", text: JSON.stringify(summary) }] };
        }
        if (fmt === "SVG" && typeof result.svg === "string") {
          if (result.colorTokens) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  nodeName: result.nodeName,
                  svg: result.svg,
                  colorTokens: result.colorTokens,
                  usedTokens: result.usedTokens
                })
              }]
            };
          }
          return { content: [{ type: "text", text: result.svg }] };
        }
        if (!result.imageBytes) throw new Error("Image payload was not received");
        return {
          content: [
            {
              type: "image",
              // MCP image content still requires base64. Conversion happens only
              // here, after the binary has crossed plugin → relay → Bun.
              data: Buffer.from(result.imageBytes).toString("base64"),
              mimeType: result.mimeType || "image/png"
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_current_figma_screenshot",
    "Capture the matching local Figma application window on macOS. This requires Screen Recording permission and a visible local Figma window. If outputPath is provided, save the image on the MCP server machine instead of returning it inline.",
    {
      maxDimension: import_zod.z.number().int().min(320).max(2400).optional().describe("Maximum output width or height in pixels (default 1200)"),
      outputPath: import_zod.z.string().optional().describe("Optional path on the MCP server machine where the captured image should be saved"),
      saveToGallery: import_zod.z.boolean().optional().describe("Save into the managed export gallery shown in the web dashboard")
    },
    async ({ maxDimension, outputPath, saveToGallery }) => {
      try {
        const localCapture = await captureLocalFigmaWindow(selectedProject?.name, maxDimension || 1200);
        const result = {
          imageBytes: localCapture.bytes,
          mimeType: localCapture.mimeType,
          nodeName: localCapture.windowName,
          source: "app-window",
          width: localCapture.width,
          height: localCapture.height,
          capturedAt: localCapture.capturedAt
        };
        if (!result.imageBytes) throw new Error("Image payload was not received");
        const metadata = {
          nodeName: result.nodeName,
          source: result.source,
          width: result.width,
          height: result.height,
          capturedAt: result.capturedAt
        };
        if (saveToGallery && !outputPath) {
          const extension = result.mimeType === "image/jpeg" ? "jpg" : "png";
          const gallery = await saveToRelayGallery(result.imageBytes, result.nodeName || "figma-screenshot", extension);
          return { content: [{ type: "text", text: JSON.stringify({ ...gallery, managed: true, ...metadata }) }] };
        }
        if (outputPath) {
          const resolved = path5.resolve(outputPath);
          fs5.mkdirSync(path5.dirname(resolved), { recursive: true });
          fs5.writeFileSync(resolved, Buffer.from(result.imageBytes));
          return { content: [{ type: "text", text: JSON.stringify({ saved: true, path: resolved, bytes: fs5.statSync(resolved).size, ...metadata }) }] };
        }
        return {
          content: [
            { type: "image", data: Buffer.from(result.imageBytes).toString("base64"), mimeType: result.mimeType || "image/png" },
            { type: "text", text: JSON.stringify(metadata) }
          ]
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error capturing current Figma screenshot: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "set_text_content",
    "Set the text content of an existing text node in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the text node to modify"),
      text: import_zod.z.string().describe("New text content")
    },
    async ({ nodeId, text }) => {
      try {
        const result = await sendCommandToFigma("set_text_content", {
          nodeId,
          text
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Updated text content of node "${typedResult.name}" to "${text}"`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting text content: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_styles",
    "Get all styles from the current Figma document",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_styles");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting styles: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_local_components",
    "Get local components and component sets (id, name, type, key, remote). Supports pagination (`limit`/`offset`, with `total`/`nextOffset` in the response) and `countOnly` for large libraries.",
    {
      limit: import_zod.z.number().int().positive().optional().describe("Max components to return; response includes total and nextOffset."),
      offset: import_zod.z.number().int().min(0).optional().describe("Start index for pagination."),
      countOnly: import_zod.z.boolean().optional().describe("Return only the total count.")
    },
    async ({ limit, offset, countOnly }) => {
      try {
        const result = await sendCommandToFigma("get_local_components", { limit, offset, countOnly });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting local components: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_annotations",
    "Get all annotations in the current document or specific node",
    {
      nodeId: import_zod.z.string().describe("node ID to get annotations for specific node"),
      includeCategories: import_zod.z.boolean().optional().default(true).describe("Whether to include category information")
    },
    async ({ nodeId, includeCategories }) => {
      try {
        const result = await sendCommandToFigma("get_annotations", {
          nodeId,
          includeCategories
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_annotation",
    "Create or update an annotation",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to annotate"),
      annotationId: import_zod.z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
      labelMarkdown: import_zod.z.string().describe("The annotation text in markdown format"),
      categoryId: import_zod.z.string().optional().describe("The ID of the annotation category"),
      properties: import_zod.z.array(import_zod.z.object({
        type: import_zod.z.string()
      })).optional().describe("Additional properties for the annotation")
    },
    async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }) => {
      try {
        const result = await sendCommandToFigma("set_annotation", {
          nodeId,
          annotationId,
          labelMarkdown,
          categoryId,
          properties
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_multiple_annotations",
    "Set multiple annotations parallelly in a node",
    {
      nodeId: import_zod.z.string().describe("The ID of the node containing the elements to annotate"),
      annotations: import_zod.z.array(
        import_zod.z.object({
          nodeId: import_zod.z.string().describe("The ID of the node to annotate"),
          labelMarkdown: import_zod.z.string().describe("The annotation text in markdown format"),
          categoryId: import_zod.z.string().optional().describe("The ID of the annotation category"),
          annotationId: import_zod.z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: import_zod.z.array(import_zod.z.object({
            type: import_zod.z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      ).describe("Array of annotations to apply")
    },
    async ({ nodeId, annotations }) => {
      try {
        if (!annotations || annotations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No annotations provided"
              }
            ]
          };
        }
        const initialStatus = {
          type: "text",
          text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`
        };
        let totalProcessed = 0;
        const totalToProcess = annotations.length;
        const result = await sendCommandToFigma("set_multiple_annotations", {
          nodeId,
          annotations
        });
        const typedResult = result;
        const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
        const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;
        const detailedResults = typedResult.results || [];
        const failedResults = detailedResults.filter((item) => !item.success);
        let detailedResponse = "";
        if (failedResults.length > 0) {
          detailedResponse = `

Nodes that failed:
${failedResults.map(
            (item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`
          ).join("\n")}`;
        }
        return {
          content: [
            initialStatus,
            {
              type: "text",
              text: progressText + detailedResponse
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "create_component_instance",
    "Create an instance of a component in Figma. For LOCAL components (from get_local_components), use componentId with the id field. For published LIBRARY components, use componentKey with the publishedKey field.",
    {
      componentId: import_zod.z.string().optional().describe("ID of a local component (use the id field from get_local_components result). Use this for unpublished/local components."),
      componentKey: import_zod.z.string().optional().describe("Key of a published library component to instantiate (use the publishedKey field from get_local_components result). Only works for published components."),
      x: import_zod.z.number().describe("X position"),
      y: import_zod.z.number().describe("Y position"),
      parentId: import_zod.z.string().optional().describe("Optional parent node ID to place the instance into")
    },
    async ({ componentId, componentKey, x, y, parentId }) => {
      try {
        const result = await sendCommandToFigma("create_component_instance", {
          componentId,
          componentKey,
          x,
          y,
          parentId
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(typedResult)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_instance_overrides",
    "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
    {
      nodeId: import_zod.z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used.")
    },
    async ({ nodeId }) => {
      try {
        const result = await sendCommandToFigma("get_instance_overrides", {
          instanceNodeId: nodeId || null
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: typedResult.success ? `Successfully got instance overrides: ${typedResult.message}` : `Failed to get instance overrides: ${typedResult.message}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_instance_overrides",
    "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
    {
      sourceInstanceId: import_zod.z.string().describe("ID of the source component instance"),
      targetNodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
    },
    async ({ sourceInstanceId, targetNodeIds }) => {
      try {
        const result = await sendCommandToFigma("set_instance_overrides", {
          sourceInstanceId,
          targetNodeIds: targetNodeIds || []
        });
        const typedResult = result;
        if (typedResult.success) {
          const successCount = typedResult.results?.filter((r) => r.success).length || 0;
          return {
            content: [
              {
                type: "text",
                text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Failed to set instance overrides: ${typedResult.message}`
              }
            ]
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_corner_radius",
    "Set the corner radius of a node in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to modify"),
      radius: import_zod.z.number().min(0).describe("Corner radius value"),
      corners: import_zod.z.array(import_zod.z.boolean()).length(4).optional().describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      )
    },
    async ({ nodeId, radius, corners }) => {
      try {
        const result = await sendCommandToFigma("set_corner_radius", {
          nodeId,
          radius,
          corners: corners || [true, true, true, true]
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Set corner radius of node "${typedResult.name}" to ${radius}px`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.prompt(
    "design_strategy",
    "Best practices for working with Figma designs",
    (extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`
            }
          }
        ],
        description: "Best practices for working with Figma designs"
      };
    }
  );
  server.prompt(
    "read_design_strategy",
    "Best practices for reading Figma designs",
    (extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `When reading Figma designs, follow these best practices:

1. Start with selection:
   - First use read_my_design() to understand the current selection
   - If no selection ask user to select single or multiple nodes
`
            }
          }
        ],
        description: "Best practices for reading Figma designs"
      };
    }
  );
  server.tool(
    "scan_text_nodes",
    "Scan all text nodes in the selected Figma node. Expensive on whole pages \u2014 if you are looking for a node by name, use search_nodes first and scan only the matched subtree.",
    {
      nodeId: import_zod.z.string().describe("ID of the node to scan"),
      chunkSize: import_zod.z.number().int().positive().optional().describe("Nodes processed per chunk (default 50). Larger = fewer round-trips/progress updates."),
      highlight: import_zod.z.boolean().optional().describe("Visually flash each text node while scanning. Default false \u2014 enabling it is much slower (adds a fill write + delay per node).")
    },
    async ({ nodeId, chunkSize, highlight }) => {
      try {
        const initialStatus = {
          type: "text",
          text: "Starting text node scanning. This may take a moment for large designs..."
        };
        const result = await sendCommandToFigma("scan_text_nodes", {
          nodeId,
          useChunking: true,
          // Enable chunking on the plugin side
          chunkSize: chunkSize || 50,
          // Process 50 nodes at a time by default
          skipHighlight: !highlight
          // Skip cosmetic per-node highlighting unless asked
        });
        if (result && typeof result === "object" && "chunks" in result) {
          const typedResult = result;
          const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;
          return {
            content: [
              initialStatus,
              {
                type: "text",
                text: summaryText
              },
              {
                type: "text",
                text: JSON.stringify(typedResult.textNodes, null, 2)
              }
            ]
          };
        }
        return {
          content: [
            initialStatus,
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "scan_nodes_by_types",
    "Scan for descendant nodes of specific types under a node. Supports pagination (`limit`/`offset` with `nextOffset` in the response) and `countOnly` for an unbounded section. INSTANCE results are enriched with `componentProperties` (variant state) and `mainComponent` (key/remote) so instance\u2192variant mapping needs no second file \u2014 enrichment is capped at 300 instances per call (`enrichmentTruncated:true` in the response means you should page with `limit` to enrich the rest). Returns a single structured JSON object (status is in fields, not separate text blocks).",
    {
      nodeId: import_zod.z.string().describe("ID of the node to scan"),
      types: import_zod.z.array(import_zod.z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME', 'INSTANCE'])"),
      limit: import_zod.z.number().int().positive().optional().describe("Max nodes to return; the response includes total and nextOffset for paging."),
      offset: import_zod.z.number().int().min(0).optional().describe("Start index for pagination (use the previous response's nextOffset)."),
      countOnly: import_zod.z.boolean().optional().describe("Return only the total count, no node payload.")
    },
    async ({ nodeId, types, limit, offset, countOnly }) => {
      try {
        const result = await sendCommandToFigma("scan_nodes_by_types", {
          nodeId,
          types,
          limit,
          offset,
          countOnly
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.prompt(
    "text_replacement_strategy",
    "Systematic approach for replacing text in Figma designs",
    (extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Scan text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
scan_text_nodes(nodeId: "node-id")
get_node_info(nodeId: "node-id")  // optional
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk
set_multiple_text_contents(
  nodeId: "parent-node-id", 
  text: [
    { nodeId: "node-id-1", text: "New text 1" },
    // More nodes in this chunk...
  ]
)

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text\u2014it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`
            }
          }
        ],
        description: "Systematic approach for replacing text in Figma designs"
      };
    }
  );
  server.tool(
    "set_multiple_text_contents",
    "Set multiple text contents parallelly in a node",
    {
      nodeId: import_zod.z.string().describe("The ID of the node containing the text nodes to replace"),
      text: import_zod.z.array(
        import_zod.z.object({
          nodeId: import_zod.z.string().describe("The ID of the text node"),
          text: import_zod.z.string().describe("The replacement text")
        })
      ).describe("Array of text node IDs and their replacement texts")
    },
    async ({ nodeId, text }) => {
      try {
        if (!text || text.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No text provided"
              }
            ]
          };
        }
        const initialStatus = {
          type: "text",
          text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`
        };
        let totalProcessed = 0;
        const totalToProcess = text.length;
        const result = await sendCommandToFigma("set_multiple_text_contents", {
          nodeId,
          text
        });
        const typedResult = result;
        const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
        const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;
        const detailedResults = typedResult.results || [];
        const failedResults = detailedResults.filter((item) => !item.success);
        let detailedResponse = "";
        if (failedResults.length > 0) {
          detailedResponse = `

Nodes that failed:
${failedResults.map(
            (item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`
          ).join("\n")}`;
        }
        return {
          content: [
            initialStatus,
            {
              type: "text",
              text: progressText + detailedResponse
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.prompt(
    "annotation_conversion_strategy",
    "Strategy for converting manual annotations to Figma's native annotations",
    (extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Automatic Annotation Conversion
            
## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Scan Annotation Text Nodes

Scan all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Get all text nodes in the selection
const textNodes = await scan_text_nodes({
  nodeId: selectedNodeId
});

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")


// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path
  
\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// Scan for all UI elements that could be annotation targets
const targetNodes = await scan_nodes_by_types({
  nodeId: selectedNodeId,
  types: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target = 
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);
  
  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);
    
    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
    annotations: annotationsToApply
  });
}
\`\`\`


This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
            }
          }
        ],
        description: "Strategy for converting manual annotations to Figma's native annotations"
      };
    }
  );
  server.prompt(
    "swap_overrides_instances",
    "Guide to swap instance overrides between instances",
    (extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, scan for instances with \`scan_nodes_by_types({ nodeId: "parent-id", types: ["INSTANCE"] })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id", 
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`get_node_info()\` or \`read_my_design()\`
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Select the appropriate Figma file first with \`use_figma_project()\` (channel ids are internal)
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`
            }
          }
        ],
        description: "Strategy for transferring overrides between component instances in Figma"
      };
    }
  );
  server.tool(
    "set_layout_mode",
    "Set the layout mode and wrap behavior of a frame in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
      layoutMode: import_zod.z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
      layoutWrap: import_zod.z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
    },
    async ({ nodeId, layoutMode, layoutWrap }) => {
      try {
        const result = await sendCommandToFigma("set_layout_mode", {
          nodeId,
          layoutMode,
          layoutWrap: layoutWrap || "NO_WRAP"
        });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ""}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_padding",
    "Set padding values for an auto-layout frame in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
      paddingTop: import_zod.z.number().optional().describe("Top padding value"),
      paddingRight: import_zod.z.number().optional().describe("Right padding value"),
      paddingBottom: import_zod.z.number().optional().describe("Bottom padding value"),
      paddingLeft: import_zod.z.number().optional().describe("Left padding value")
    },
    async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }) => {
      try {
        const result = await sendCommandToFigma("set_padding", {
          nodeId,
          paddingTop,
          paddingRight,
          paddingBottom,
          paddingLeft
        });
        const typedResult = result;
        const paddingMessages = [];
        if (paddingTop !== void 0) paddingMessages.push(`top: ${paddingTop}`);
        if (paddingRight !== void 0) paddingMessages.push(`right: ${paddingRight}`);
        if (paddingBottom !== void 0) paddingMessages.push(`bottom: ${paddingBottom}`);
        if (paddingLeft !== void 0) paddingMessages.push(`left: ${paddingLeft}`);
        const paddingText = paddingMessages.length > 0 ? `padding (${paddingMessages.join(", ")})` : "padding";
        return {
          content: [
            {
              type: "text",
              text: `Set ${paddingText} for frame "${typedResult.name}"`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_axis_align",
    "Set primary and counter axis alignment for an auto-layout frame in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
      primaryAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional().describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
      counterAxisAlignItems: import_zod.z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
    },
    async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }) => {
      try {
        const result = await sendCommandToFigma("set_axis_align", {
          nodeId,
          primaryAxisAlignItems,
          counterAxisAlignItems
        });
        const typedResult = result;
        const alignMessages = [];
        if (primaryAxisAlignItems !== void 0) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
        if (counterAxisAlignItems !== void 0) alignMessages.push(`counter: ${counterAxisAlignItems}`);
        const alignText = alignMessages.length > 0 ? `axis alignment (${alignMessages.join(", ")})` : "axis alignment";
        return {
          content: [
            {
              type: "text",
              text: `Set ${alignText} for frame "${typedResult.name}"`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_layout_sizing",
    "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
    {
      nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
      layoutSizingHorizontal: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
      layoutSizingVertical: import_zod.z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
    },
    async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }) => {
      try {
        const result = await sendCommandToFigma("set_layout_sizing", {
          nodeId,
          layoutSizingHorizontal,
          layoutSizingVertical
        });
        const typedResult = result;
        const sizingMessages = [];
        if (layoutSizingHorizontal !== void 0) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
        if (layoutSizingVertical !== void 0) sizingMessages.push(`vertical: ${layoutSizingVertical}`);
        const sizingText = sizingMessages.length > 0 ? `layout sizing (${sizingMessages.join(", ")})` : "layout sizing";
        return {
          content: [
            {
              type: "text",
              text: `Set ${sizingText} for frame "${typedResult.name}"`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_item_spacing",
    "Set distance between children in an auto-layout frame",
    {
      nodeId: import_zod.z.string().describe("The ID of the frame to modify"),
      itemSpacing: import_zod.z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
      counterAxisSpacing: import_zod.z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
    },
    async ({ nodeId, itemSpacing, counterAxisSpacing }) => {
      try {
        const params = { nodeId };
        if (itemSpacing !== void 0) params.itemSpacing = itemSpacing;
        if (counterAxisSpacing !== void 0) params.counterAxisSpacing = counterAxisSpacing;
        const result = await sendCommandToFigma("set_item_spacing", params);
        const typedResult = result;
        let message = `Updated spacing for frame "${typedResult.name}":`;
        if (itemSpacing !== void 0) message += ` itemSpacing=${itemSpacing}`;
        if (counterAxisSpacing !== void 0) message += ` counterAxisSpacing=${counterAxisSpacing}`;
        return {
          content: [
            {
              type: "text",
              text: message
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_motion",
    "Read Figma Motion animation data (Animation panel) for a node and its descendants: `animations` keyframes per animatable field, `manualKeyframeTracks`, `timelines`, and applied `animationStyles`, plus the document's timelines and available animation styles. This is NOT prototype data \u2014 Motion animations are invisible to `get_reactions`. Use this to get exact durations, keyframe positions and easing for looping/ambient animations.",
    {
      nodeId: import_zod.z.string().describe("Node ID to read Motion data from (its subtree is included)"),
      maxDepth: import_zod.z.number().int().min(0).optional().describe("How many levels below the node to include. Defaults to 6.")
    },
    async ({ nodeId, maxDepth }) => {
      try {
        const result = await sendCommandToFigma("get_motion", { nodeId, maxDepth });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading Motion data: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "get_reactions",
    "Get Figma Prototyping Reactions from multiple nodes. Searches each node and its descendants. For deeply nested nodes, pass `maxDepth` to cap how far the search recurses (an unbounded deep scan can time out). CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
    {
      nodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of node IDs to get reactions from"),
      maxDepth: import_zod.z.number().int().min(0).optional().describe("Max levels below each given node to search for reactions. 0 = the given node only, 1 = its direct children, etc. Omit to search the full subtree. Use this when a deep node makes the scan time out.")
    },
    async ({ nodeIds, maxDepth }) => {
      try {
        const result = await sendCommandToFigma("get_reactions", { nodeIds, maxDepth });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            },
            {
              type: "text",
              text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step."
            }
          ],
          followUp: {
            type: "prompt",
            prompt: "reaction_to_connector_strategy"
          }
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_default_connector",
    "Set a copied connector node as the default connector",
    {
      connectorId: import_zod.z.string().optional().describe("The ID of the connector node to set as default")
    },
    async ({ connectorId }) => {
      try {
        const result = await sendCommandToFigma("set_default_connector", {
          connectorId
        });
        return {
          content: [
            {
              type: "text",
              text: `Default connector set: ${JSON.stringify(result)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "create_connections",
    "Create connections between nodes using the default connector style",
    {
      connections: import_zod.z.array(import_zod.z.object({
        startNodeId: import_zod.z.string().describe("ID of the starting node"),
        endNodeId: import_zod.z.string().describe("ID of the ending node"),
        text: import_zod.z.string().optional().describe("Optional text to display on the connector")
      })).describe("Array of node connections to create")
    },
    async ({ connections }) => {
      try {
        if (!connections || connections.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No connections provided"
              }
            ]
          };
        }
        const result = await sendCommandToFigma("create_connections", {
          connections
        });
        return {
          content: [
            {
              type: "text",
              text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_focus",
    "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
    {
      nodeId: import_zod.z.string().describe("The ID of the node to focus on")
    },
    async ({ nodeId }) => {
      try {
        const result = await sendCommandToFigma("set_focus", { nodeId });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "set_selections",
    "Set selection to multiple nodes in Figma and scroll viewport to show them",
    {
      nodeIds: import_zod.z.array(import_zod.z.string()).describe("Array of node IDs to select")
    },
    async ({ nodeIds }) => {
      try {
        const result = await sendCommandToFigma("set_selections", { nodeIds });
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map((node) => `"${node.name}" (${node.id})`).join(", ")}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  server.prompt(
    "reaction_to_connector_strategy",
    "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    (extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Strategy: Convert Figma Prototype Reactions to Connector Lines

## Goal
Process the JSON output from the \`get_reactions\` tool to generate an array of connection objects suitable for the \`create_connections\` tool. This visually represents prototype flows as connector lines on the Figma canvas.

## Input Data
You will receive JSON data from the \`get_reactions\` tool. This data contains an array of nodes, each with potential reactions. A typical reaction object looks like this:
\`\`\`json
{
  "trigger": { "type": "ON_CLICK" },
  "action": {
    "type": "NAVIGATE",
    "destinationId": "destination-node-id",
    "navigationTransition": { ... },
    "preserveScrollPosition": false
  }
}
\`\`\`

## Step-by-Step Process

### 1. Preparation & Context Gathering
   - **Action:** Call \`read_my_design\` on the relevant node(s) to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
   - **Action:** Call \`set_default_connector\` **without** the \`connectorId\` parameter.
   - **Check Result:** Analyze the response from \`set_default_connector\`.
     - If it confirms a default connector is already set (e.g., "Default connector is already set"), proceed to Step 2.
     - If it indicates no default connector is set (e.g., "No default connector set..."), you **cannot** proceed with \`create_connections\` yet. Inform the user they need to manually copy a connector from FigJam, paste it onto the current page, select it, and then you can run \`set_default_connector({ connectorId: "SELECTED_NODE_ID" })\` before attempting \`create_connections\`. **Do not proceed to Step 2 until a default connector is confirmed.**

### 2. Filter and Transform Reactions from \`get_reactions\` Output
   - **Iterate:** Go through the JSON array provided by \`get_reactions\`. For each node in the array:
     - Iterate through its \`reactions\` array.
   - **Filter:** Keep only reactions where the \`action\` meets these criteria:
     - Has a \`type\` that implies a connection (e.g., \`NAVIGATE\`, \`OPEN_OVERLAY\`, \`SWAP_OVERLAY\`). **Ignore** types like \`CHANGE_TO\`, \`CLOSE_OVERLAY\`, etc.
     - Has a valid \`destinationId\` property.
   - **Extract:** For each valid reaction, extract the following information:
     - \`sourceNodeId\`: The ID of the node the reaction belongs to (from the outer loop).
     - \`destinationNodeId\`: The value of \`action.destinationId\`.
     - \`actionType\`: The value of \`action.type\`.
     - \`triggerType\`: The value of \`trigger.type\`.

### 3. Generate Connector Text Labels
   - **For each extracted connection:** Create a concise, descriptive text label string.
   - **Combine Information:** Use the \`actionType\`, \`triggerType\`, and potentially the names of the source/destination nodes (obtained from Step 1's \`read_my_design\` or by calling \`get_node_info\` if necessary) to generate the label.
   - **Example Labels:**
     - If \`triggerType\` is "ON_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON_DRAG" and \`actionType\` is "OPEN_OVERLAY": "On drag, open [Destination Node Name] overlay"
   - **Keep it brief and informative.** Let this generated string be \`generatedText\`.

### 4. Prepare the \`connections\` Array for \`create_connections\`
   - **Structure:** Create a JSON array where each element is an object representing a connection.
   - **Format:** Each object in the array must have the following structure:
     \`\`\`json
     {
       "startNodeId": "sourceNodeId_from_step_2",
       "endNodeId": "destinationNodeId_from_step_2",
       "text": "generatedText_from_step_3"
     }
     \`\`\`
   - **Result:** This final array is the value you will pass to the \`connections\` parameter when calling the \`create_connections\` tool.

### 5. Execute Connection Creation
   - **Action:** Call the \`create_connections\` tool, passing the array generated in Step 4 as the \`connections\` argument.
   - **Verify:** Check the response from \`create_connections\` to confirm success or failure.

This detailed process ensures you correctly interpret the reaction data, prepare the necessary information, and use the appropriate tools to create the connector lines.`
            }
          }
        ],
        description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'"
      };
    }
  );
  function processFigmaNodeResponse(result) {
    if (!result || typeof result !== "object") {
      return result;
    }
    const resultObj = result;
    if ("id" in resultObj && typeof resultObj.id === "string") {
      console.info(
        `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id})`
      );
      if ("x" in resultObj && "y" in resultObj) {
        console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
      }
      if ("width" in resultObj && "height" in resultObj) {
        console.debug(`Node dimensions: ${resultObj.width}\xD7${resultObj.height}`);
      }
    }
    return result;
  }
  function connectToFigma(port = 3055) {
    if (disposed) return;
    if (ws && ws.readyState === import_ws.default.OPEN) {
      logger.info("Already connected to Figma");
      return;
    }
    const wsUrl = serverUrl === "localhost" ? `ws://localhost:${port}` : RELAY_WS_URL;
    logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
    ws = new import_ws.default(wsUrl);
    ws.on("open", () => {
      logger.info("Connected to Figma socket server");
      currentChannel = null;
      fatalProtocolError = null;
      ws?.send(JSON.stringify({
        type: "hello",
        role: "controller",
        requesterId,
        protocolVersion: PROTOCOL_VERSION,
        deviceName: process.env.TALK_TO_FIGMA_DEVICE_NAME || os5.hostname(),
        platform: `${os5.platform()} ${os5.arch()}`,
        capabilities: ["binaryFrames", "livePreview"]
      }));
      if (desiredChannel) {
        joinChannel(desiredChannel).catch(
          (error) => logger.warn(`Could not resume project connection: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
    });
    ws.on("message", (data, isBinary) => {
      try {
        let binaryPayload;
        let json;
        if (isBinary) {
          const decoded = decodeBinaryFrame(data);
          json = decoded.envelope;
          binaryPayload = decoded.payload;
        } else {
          json = JSON.parse(rawDataToBuffer(data).toString("utf8"));
        }
        if (json.type === "system" && json.event === "protocol_mismatch") {
          fatalProtocolError = String(json.message || `Protocol mismatch. MCP=${PROTOCOL_VERSION}`);
          currentChannel = null;
          desiredChannel = null;
          pendingRequests.forEach((request, id) => {
            clearTimeout(request.timeout);
            request.reject(new Error(fatalProtocolError));
            pendingRequests.delete(id);
          });
          logger.error(fatalProtocolError);
          return;
        }
        if (json.type === "progress_update") {
          const progressData = json.message.data;
          const requestId = json.id || "";
          if (requestId && pendingRequests.has(requestId)) {
            const request = pendingRequests.get(requestId);
            request.lastActivity = Date.now();
            clearTimeout(request.timeout);
            request.timeout = setTimeout(() => {
              if (pendingRequests.has(requestId)) {
                logger.error(`Request ${requestId} timed out after extended period of inactivity`);
                pendingRequests.delete(requestId);
                if (ws?.readyState === import_ws.default.OPEN) {
                  ws.send(JSON.stringify({ type: "request_timeout", id: requestId, channel: request.channel, requesterId }));
                }
                request.reject(new Error("Request to Figma timed out"));
              }
            }, 6e4);
            logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
            if (progressData.status === "completed" && progressData.progress === 100) {
              logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
            }
          }
          return;
        }
        if (json.type === "system" && json.event === "channel_closed") {
          logger.warn(`Channel "${json.channel}" closed: the Figma plugin left. You must join a channel again.`);
          currentChannel = null;
          const reason = new Error(
            "Channel closed: the Figma plugin disconnected. Use list_figma_channels to find the current channel, then join_channel again."
          );
          pendingRequests.forEach((request, id) => {
            clearTimeout(request.timeout);
            request.reject(reason);
            pendingRequests.delete(id);
          });
          return;
        }
        const myResponse = json.message;
        logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
        logger.log("myResponse" + JSON.stringify(myResponse));
        if (myResponse?.id && pendingRequests.has(myResponse.id) && (myResponse.result !== void 0 || myResponse.error !== void 0)) {
          const request = pendingRequests.get(myResponse.id);
          clearTimeout(request.timeout);
          if (myResponse.error) {
            logger.error(`Error from Figma: ${myResponse.error}`);
            request.reject(new Error(myResponse.error));
          } else {
            let result = myResponse.result;
            if (binaryPayload) {
              result = { ...result, imageBytes: binaryPayload, byteLength: binaryPayload.byteLength };
            } else if (result?.imageData && !result.imageBytes) {
              result = { ...result, imageBytes: Buffer.from(result.imageData, "base64") };
            }
            if (myResponse.timing && result && typeof result === "object") {
              result = { ...result, _timing: myResponse.timing };
            }
            request.resolve(result);
          }
          pendingRequests.delete(myResponse.id);
        } else {
          logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
        }
      } catch (error) {
        logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    ws.on("error", (error) => {
      logger.error(`Socket error: ${error}`);
    });
    ws.on("close", () => {
      logger.info("Disconnected from Figma socket server");
      ws = null;
      for (const [id, request] of pendingRequests.entries()) {
        clearTimeout(request.timeout);
        request.reject(new Error("Connection closed"));
        pendingRequests.delete(id);
      }
      if (!disposed) {
        if (fatalProtocolError) {
          logger.error(`Reconnect paused: ${fatalProtocolError}`);
        } else {
          logger.info("Attempting to reconnect in 2 seconds...");
          reconnectTimer = setTimeout(() => connectToFigma(port), 2e3);
        }
      }
    });
  }
  async function joinChannel(channelName) {
    if (!ws || ws.readyState !== import_ws.default.OPEN) {
      throw new Error("Not connected to Figma");
    }
    try {
      await sendCommandToFigma("join", { channel: channelName });
      currentChannel = channelName;
      desiredChannel = channelName;
      logger.info(`Joined channel: ${channelName}`);
    } catch (error) {
      logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  async function relayProjectsPayload() {
    const httpUrl = relayHttpUrl("projects");
    const response = await fetch(httpUrl);
    if (!response.ok) throw new Error(`relay returned HTTP ${response.status}`);
    return await response.json();
  }
  async function relayProjects() {
    return (await relayProjectsPayload()).projects || [];
  }
  async function selectProject(query) {
    const projects = await relayProjects();
    const live = projects.filter((project2) => project2.connectionCount > 0 && project2.recommendedChannel);
    if (!live.length) throw new Error("No live Figma projects are connected");
    let matches = live;
    if (query) {
      const normalized = query.toLowerCase();
      matches = live.filter(
        (project2) => [project2.name, project2.fileKey, project2.projectKey].some((value) => String(value || "").toLowerCase().includes(normalized))
      );
    }
    if (matches.length !== 1) {
      throw new Error(query ? `Project query matched ${matches.length} projects: ${matches.map((project2) => project2.name).join(", ") || "none"}` : `Choose a project first \u2014 call use_figma_project with one of: ${live.map((project2) => project2.name).join(", ")}`);
    }
    const project = matches[0];
    await joinChannel(project.recommendedChannel);
    selectedProject = { projectKey: project.projectKey, name: project.name, fileKey: project.fileKey };
    persistSelectedProject(selectedProject);
    return project;
  }
  function currentProjectKey() {
    return selectedProject?.projectKey || selectedProject?.fileKey || selectedProject?.name || "";
  }
  async function fetchProjectContextFromDocument(timeoutMs = 15e3) {
    const result = await sendCommandToFigma("get_project_context", {}, timeoutMs);
    const projectKey = currentProjectKey();
    if (projectKey) {
      if (result?.exists && typeof result.content === "string") {
        cacheProjectContext(projectKey, {
          content: result.content,
          updatedAt: result.updatedAt ?? null,
          updatedBy: result.updatedBy ?? null
        });
      } else {
        clearCachedProjectContext(projectKey);
      }
    }
    return result;
  }
  function buildContextDraftMaterial(projectKey) {
    const index = loadProjectIndex(projectKey);
    if (!index || !index.pages.length) return null;
    const pages = index.pages.map((page) => {
      const name = page.pageName || "";
      const flags = [];
      if (/\[ab\]|\bab ?test|실험|experiment/i.test(name)) flags.push("experiment?");
      if (/^[\s\-=—–─═*·.·|/\\]+$/.test(name)) flags.push("divider");
      if (/개인|personal|playground|scratch|sandbox|draft|드래프트/i.test(name)) flags.push("personal?");
      if (/레퍼런스|reference|벤치마크|benchmark|모음|캡처|capture|스크린샷|screenshot/i.test(name)) flags.push("reference?");
      if (/아카이브|archive|백업|backup|\bold\b|deprecated|미사용|legacy/i.test(name)) flags.push("archive?");
      return {
        name,
        nodeCount: page.entries.length,
        ...flags.length ? { flags } : {}
      };
    });
    return { source: "disk-index", indexedAt: index.builtAt ?? index.updatedAt, pages };
  }
  async function ensureProjectSelected() {
    if (currentChannel) return;
    if (selectedProject) {
      try {
        await selectProject(selectedProject.fileKey || selectedProject.projectKey || selectedProject.name);
        return;
      } catch (error) {
        logger.warn(`Previously selected project "${selectedProject.name}" is not available: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await selectProject();
  }
  async function sendCommandToFigma(command, params = {}, timeoutMs = 3e4) {
    if (command !== "join") await ensureProjectSelected();
    return new Promise((resolve2, reject) => {
      if (fatalProtocolError) {
        reject(new Error(fatalProtocolError));
        return;
      }
      if (!ws || ws.readyState !== import_ws.default.OPEN) {
        connectToFigma();
        reject(new Error("Not connected to Figma. Attempting to connect..."));
        return;
      }
      const requiresChannel = command !== "join";
      if (requiresChannel && !currentChannel) {
        reject(new Error("Must join a channel before sending commands"));
        return;
      }
      const id = (0, import_uuid.v4)();
      const request = {
        id,
        type: command === "join" ? "join" : "message",
        requesterId,
        ...command === "join" ? { channel: params.channel } : { channel: currentChannel },
        message: {
          id,
          command,
          params: {
            ...params,
            commandId: id
            // Include the command ID in params
          }
        }
      };
      const timeout = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          if (ws?.readyState === import_ws.default.OPEN) {
            ws.send(JSON.stringify({ type: "request_timeout", id, channel: currentChannel, requesterId }));
          }
          logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1e3} seconds`);
          reject(new Error("Request to Figma timed out"));
        }
      }, timeoutMs);
      pendingRequests.set(id, {
        resolve: resolve2,
        reject,
        timeout,
        lastActivity: Date.now(),
        command,
        channel: currentChannel
      });
      logger.info(`Sending command to Figma: ${command}`);
      logger.debug(`Request details: ${JSON.stringify(request)}`);
      ws.send(JSON.stringify(request));
    });
  }
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === import_ws.default.OPEN) {
      ws.send(JSON.stringify({
        type: "heartbeat",
        role: "controller",
        requesterId,
        protocolVersion: PROTOCOL_VERSION,
        channel: currentChannel,
        ts: Date.now()
      }));
    }
  }, 1e4);
  server.tool(
    "list_pages",
    "List all pages in the file (id, name, childCount) and the current page id. Use this to discover non-open pages, then set_current_page or pass pageId to get_document_info. If you know (part of) a node's name, use search_nodes first; for pages plus their top-level children in one call, use get_file_outline.",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("list_pages");
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error listing pages: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "search_nodes",
    "Search the WHOLE FILE (every page) in a single call for nodes matching the query (case-insensitive) \u2014 by node NAME and/or by on-screen TEXT content (a TEXT node's characters, i.e. the UI copy). So you can find a screen both by its layer name and by the wording visible in it, even when layers are named differently from the feature. Do NOT walk pages one by one with get_document_info or scan whole pages with scan_text_nodes to find something \u2014 use this tool first, then drill into the returned node/page ids. IMPORTANT: pass EVERY plausible spelling of the concept you are looking for in `queries` at once \u2014 Korean/English, joined/spaced, product name vs feature name (e.g. ['\uC9D0\uCC57','GymChat','Gym Chat']); they are OR-matched in one pass. Matching also ignores whitespace ('gym chat' matches a 'GymChat' layer). When the relay's background indexer has built a disk index for the project, the search answers from it instantly (response carries source: 'index' and indexedAt); pass fresh: true to force a live search if the index may be stale. Without an index, pages are searched live and sequentially (current page first, then file order), stopping as soon as `limit` matches are found \u2014 the FIRST such search must load and index each page, which can take tens of seconds on large files; later searches hit a per-page cache in the plugin and return in well under a second. Each match includes {id, name, type, pageId, pageName, path, matchedBy, matchedQuery} (text matches also carry a matchedText snippet); name matches sort before text matches. Keyword annotations registered via add_search_annotation are returned first with matchedBy: 'annotation' (not counted against `limit`). Optionally filter by node types or restrict to one page.",
    {
      query: import_zod.z.string().optional().describe("Substring to match (case-insensitive, whitespace-insensitive) against node names and/or TEXT content. Provide this and/or `queries`."),
      queries: import_zod.z.array(import_zod.z.string()).optional().describe("Multiple spellings/variants of the concept, OR-matched in one pass (e.g. ['\uC9D0\uCC57','GymChat','Gym Chat']). Provide this and/or `query`; both are merged."),
      match: import_zod.z.enum(["name", "text", "both"]).optional().describe("What to match: 'name' = node names only, 'text' = TEXT node characters (UI copy) only, 'both' = either (default)."),
      types: import_zod.z.array(import_zod.z.string()).optional().describe("Optional node types to restrict NAME matching to, e.g. ['FRAME','COMPONENT','SECTION','TEXT']. Text matching always targets TEXT nodes."),
      pageId: import_zod.z.string().optional().describe("Restrict the search to this page only (from list_pages/get_file_outline)."),
      limit: import_zod.z.number().int().positive().optional().describe("Max matches to return (default 50, max 200)."),
      fresh: import_zod.z.boolean().optional().describe("Skip the relay-built disk index and search the live file page by page. RARELY needed: the index is refreshed incrementally within minutes of edits, so prefer the default (index) path \u2014 a live full-file scan takes 30s+ and returns a partial result if it exceeds its 60s budget. Use only when you have concrete evidence the index is missing something changed seconds ago, or combine with pageId to keep it cheap.")
    },
    async ({ query, queries, match, types, pageId, limit, fresh }) => {
      try {
        const PER_PAGE_TIMEOUT_MS = 3e4;
        const mode = match === "name" || match === "text" ? match : "both";
        const max = Math.max(1, Math.min(Number(limit) || 50, 200));
        const allQueries = [
          ...typeof query === "string" ? [query] : [],
          ...Array.isArray(queries) ? queries.filter((q) => typeof q === "string") : []
        ].filter((q) => q.trim().length > 0);
        if (!allQueries.length) {
          return { content: [{ type: "text", text: "Error searching nodes: provide `query` and/or `queries`" }] };
        }
        await ensureProjectSelected();
        const projectKey = selectedProject?.projectKey || selectedProject?.fileKey || selectedProject?.name || "";
        const contextFlag = hasCachedProjectContext(projectKey) ? { hasContext: true, contextNote: "\uC774 \uD504\uB85C\uC81D\uD2B8\uC5D0\uB294 \uCEE8\uD14D\uC2A4\uD2B8 \uBB38\uC11C\uAC00 \uC788\uB2E4 \u2014 \uACB0\uACFC \uD574\uC11D \uC804(\uC5B4\uB290 \uD398\uC774\uC9C0\uC758 \uBB34\uC5C7\uC778\uC9C0 \uD310\uB2E8\uD558\uAE30 \uC804) get_project_context \uB97C \uD655\uC778\uD558\uB77C." } : {};
        const annotationMatches = findAnnotationsForKeys(
          projectKey,
          allQueries.map(normalizeKeywordKey)
        ).map((a) => ({
          id: a.nodeId,
          name: a.nodeName,
          matchedBy: "annotation",
          matchedQuery: a.keyword,
          ...a.note ? { note: a.note } : {},
          addedAt: a.addedAt
        }));
        if (!fresh && !pageId) {
          const projectIndex = loadProjectIndex(projectKey);
          if (projectIndex && projectIndex.pages.length > 0) {
            const needles = buildNeedles(allQueries);
            const typeSet = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
            const matches2 = [];
            let totalMatches2 = 0;
            let truncated2 = false;
            for (const page of projectIndex.pages) {
              const nameFound = [];
              const textFound = [];
              for (const entry of page.entries) {
                let matched = false;
                if (mode !== "text" && (!typeSet || typeSet.has(entry.type))) {
                  for (const needle of needles) {
                    if (findNormalizedMatch(entry.name, needle.qLower, needle.qLowerNoSpace)) {
                      nameFound.push({ entry, matchedQuery: needle.raw });
                      matched = true;
                      break;
                    }
                  }
                }
                if (!matched && mode !== "name" && entry.characters !== null) {
                  for (const needle of needles) {
                    const range = findNormalizedMatch(entry.characters, needle.qLower, needle.qLowerNoSpace);
                    if (range) {
                      textFound.push({ entry, matchedQuery: needle.raw, range });
                      break;
                    }
                  }
                }
              }
              totalMatches2 += nameFound.length + textFound.length;
              for (const found of nameFound) {
                if (matches2.length >= max) {
                  truncated2 = true;
                  break;
                }
                matches2.push({
                  id: found.entry.id,
                  name: found.entry.name,
                  type: found.entry.type,
                  pageId: page.pageId,
                  pageName: page.pageName,
                  path: found.entry.path,
                  matchedBy: "name",
                  matchedQuery: found.matchedQuery
                });
              }
              if (!truncated2) {
                for (const found of textFound) {
                  if (matches2.length >= max) {
                    truncated2 = true;
                    break;
                  }
                  matches2.push({
                    id: found.entry.id,
                    name: found.entry.name,
                    type: found.entry.type,
                    pageId: page.pageId,
                    pageName: page.pageName,
                    path: found.entry.path,
                    matchedBy: "text",
                    matchedQuery: found.matchedQuery,
                    matchedText: textMatchSnippet(found.entry.characters, found.range)
                  });
                }
              }
            }
            const result2 = {
              ...contextFlag,
              queries: allQueries,
              match: mode,
              source: "index",
              indexedAt: projectIndex.builtAt ?? projectIndex.updatedAt,
              totalMatches: totalMatches2,
              truncated: truncated2,
              totalScannedPages: projectIndex.pages.length,
              totalPages: projectIndex.pages.length,
              matches: [...annotationMatches, ...matches2]
            };
            if (truncated2) {
              result2.note = `Only the first ${max} matches are returned (totalMatches counts all index hits). The result came from the disk index built at ${new Date(result2.indexedAt).toISOString()}; pass fresh: true to search the live file instead.`;
            }
            return { content: [{ type: "text", text: JSON.stringify(result2) }] };
          }
        }
        let pageOrder;
        if (pageId) {
          pageOrder = [{ id: pageId, name: "" }];
        } else {
          const pageList = await sendCommandToFigma(
            "list_pages",
            { withChildCounts: false },
            PER_PAGE_TIMEOUT_MS
          );
          const pages = pageList?.pages || [];
          const currentId = pageList?.currentPageId;
          pageOrder = [
            ...pages.filter((p) => p.id === currentId),
            ...pages.filter((p) => p.id !== currentId)
          ];
        }
        const matches = [];
        const unreadablePages = [];
        let totalMatches = 0;
        let totalScannedPages = 0;
        let truncated = false;
        const LIVE_BUDGET_MS = 6e4;
        const liveStart = Date.now();
        let budgetExhausted = false;
        for (const page of pageOrder) {
          const remaining = max - matches.length;
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          if (Date.now() - liveStart > LIVE_BUDGET_MS) {
            budgetExhausted = true;
            break;
          }
          totalScannedPages++;
          try {
            const pageResult = await sendCommandToFigma(
              "search_nodes",
              { queries: allQueries, match: mode, types, pageId: page.id, limit: remaining },
              PER_PAGE_TIMEOUT_MS
            );
            totalMatches += pageResult?.totalMatches || 0;
            if (Array.isArray(pageResult?.matches)) matches.push(...pageResult.matches);
            if (pageResult?.truncated) truncated = true;
          } catch (error) {
            unreadablePages.push({
              id: page.id,
              name: page.name,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        const result = {
          ...contextFlag,
          queries: allQueries,
          match: mode,
          source: "live",
          totalMatches,
          truncated,
          totalScannedPages,
          totalPages: pageOrder.length,
          matches: [...annotationMatches, ...matches]
        };
        if (truncated) {
          result.note = `Stopped after ${totalScannedPages}/${pageOrder.length} pages once the limit of ${max} matches was reached; totalMatches counts scanned pages only.`;
        }
        if (budgetExhausted) {
          result.incomplete = true;
          result.note = `Time budget (${LIVE_BUDGET_MS / 1e3}s) exhausted after ${totalScannedPages}/${pageOrder.length} pages \u2014 this is a PARTIAL result. Re-run without fresh (the disk index covers the whole file), or narrow with pageId.`;
        }
        if (unreadablePages.length) result.unreadablePages = unreadablePages;
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error searching nodes: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  function parseNodeKeywordValue(raw) {
    if (typeof raw !== "string" || !raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((k) => k && typeof k.keyword === "string" && k.keyword.trim());
    } catch {
      return [];
    }
  }
  async function readNodeKeywords(nodeId) {
    const data = await sendCommandToFigma("get_node_data", {
      nodeId,
      namespace: "talk_to_figma",
      key: "search_keywords"
    });
    return parseNodeKeywordValue(data?.value);
  }
  server.tool(
    "add_search_annotation",
    "Register a learned keyword\u2192node link so future search_nodes calls surface it on top (matchedBy: 'annotation'). Use this when a search did NOT find the right node but you identified it through another route (a task description, a Slack link, an operator's answer): register the keyword the search failed on, pointing at the confirmed node. The link is stored ON THE NODE ITSELF inside the Figma document (sharedPluginData), so it follows the file across machines and is deleted with the node; the local disk copy is only a search cache. Requires a live plugin connection. The keyword is normalized (lowercase, whitespace removed) for lookup; the original spelling is preserved. Same keyword+node updates in place.",
    {
      keyword: import_zod.z.string().describe("The search keyword this node should be found under (the term the search failed on). Original spelling is kept; matching is case- and whitespace-insensitive."),
      nodeId: import_zod.z.string().describe("The confirmed node id the keyword should resolve to."),
      note: import_zod.z.string().optional().describe("Optional context for future readers (why this node, source of the confirmation).")
    },
    async ({ keyword, nodeId, note }) => {
      try {
        if (!keyword || !keyword.trim()) throw new Error("keyword must be non-empty");
        const trimmed = keyword.trim();
        const keywordKey = normalizeKeywordKey(trimmed);
        const current = await readNodeKeywords(nodeId);
        const kept = current.filter((k) => normalizeKeywordKey(k.keyword) !== keywordKey);
        kept.push({ keyword: trimmed, ...note ? { note } : {}, addedAt: (/* @__PURE__ */ new Date()).toISOString() });
        const saved = await sendCommandToFigma("set_node_keywords", { nodeId, keywords: kept });
        const projectKey = currentProjectKey();
        const annotation = upsertSearchAnnotation({
          keyword: trimmed,
          projectKey,
          nodeId,
          nodeName: String(saved?.nodeName ?? ""),
          note
        });
        return { content: [{ type: "text", text: JSON.stringify({ saved: true, storedOnNode: true, annotation }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error adding search annotation: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "remove_search_annotation",
    "Remove learned keyword\u2192node annotation(s) for the CURRENT project. Use this when the operator (or any feedback) says an annotated answer was WRONG \u2014 remove it so searches stop surfacing it. Removes the keyword from the node's own sharedPluginData (the source of truth, requires a live plugin connection) and from the local search cache. Omit nodeId to remove every annotation stored under the keyword.",
    {
      keyword: import_zod.z.string().describe("The keyword whose annotation(s) to remove (case- and whitespace-insensitive)."),
      nodeId: import_zod.z.string().optional().describe("Remove only the annotation pointing at this node; omit to remove ALL annotations for the keyword.")
    },
    async ({ keyword, nodeId }) => {
      try {
        if (!keyword || !keyword.trim()) throw new Error("keyword must be non-empty");
        await ensureProjectSelected();
        const projectKey = currentProjectKey();
        const keywordKey = normalizeKeywordKey(keyword.trim());
        const targetNodeIds = nodeId ? [nodeId] : [...new Set(findAnnotationsForKeys(projectKey, [keywordKey]).map((a) => a.nodeId))];
        const nodeResults = [];
        for (const target of targetNodeIds) {
          try {
            const current = await readNodeKeywords(target);
            const kept = current.filter((k) => normalizeKeywordKey(k.keyword) !== keywordKey);
            if (kept.length !== current.length) {
              await sendCommandToFigma("set_node_keywords", { nodeId: target, keywords: kept });
              nodeResults.push({ nodeId: target, removed: true });
            } else {
              nodeResults.push({ nodeId: target, removed: false });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/not found/i.test(message)) nodeResults.push({ nodeId: target, removed: false });
            else nodeResults.push({ nodeId: target, removed: false, error: message });
          }
        }
        if (nodeResults.some((r) => r.error)) {
          throw new Error(`Failed to update node(s): ${nodeResults.filter((r) => r.error).map((r) => `${r.nodeId}: ${r.error}`).join("; ")}`);
        }
        const removed = removeSearchAnnotations({ keyword: keyword.trim(), projectKey, nodeId });
        return { content: [{ type: "text", text: JSON.stringify({ removed, nodes: nodeResults }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error removing search annotation: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "list_relay_errors",
    "\uC778\uB371\uC11C\xB7\uCEE4\uB9E8\uB4DC\xB7\uC2A4\uD06C\uB9BD\uD2B8 \uC5D0\uB7EC \uC6D0\uC7A5 \u2014 \uBC18\uBCF5\uB418\uB294 \uC5D0\uB7EC\uB294 \uAC1C\uC120 \uB300\uC0C1\uC73C\uB85C \uBCF4\uACE0\uD558\uB77C. Reads the shared on-disk error ledger (~/.talk-to-figma/errors.json) the relay maintains: indexer step failures and partial pages (skipped unknown-typed nodes), relayed plugin command errors/timeouts, /script/run failures, and relay-internal exceptions. Entries are newest-first; consecutive identical errors are collapsed with a `count`. An entry with a high count (or the same message recurring across days) is a signal the tooling itself should be fixed, not worked around.",
    {
      limit: import_zod.z.number().optional().describe("Max entries to return (default 100, cap 500)."),
      source: import_zod.z.enum(["indexer", "command", "script", "relay"]).optional().describe("Only errors from this source.")
    },
    async ({ limit, source }) => {
      try {
        const errors = loadRelayErrors({ limit, source });
        return { content: [{ type: "text", text: JSON.stringify({ count: errors.length, errors }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error reading relay error ledger: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "run_figma_script",
    "Run arbitrary JavaScript inside the Figma plugin sandbox with FULL access to the figma plugin API \u2014 use this to fill gaps where no dedicated tool exists. The code body may use await and must `return` the value you want back; the return value is serialized (JSON.stringify, falling back to String(), capped at 100KB) and returned in this tool's response, with thrown errors returned as message+stack. WARNING: this can MODIFY THE DOCUMENT directly \u2014 verify your target nodes before destructive changes (nothing is auto-committed; undo relies on Figma's own undo/version history). A synchronous infinite loop FREEZES the plugin with no way to abort remotely (the operator must re-run the plugin in Figma). If a dedicated tool already does the job, use the dedicated tool instead. Timeout 120s.",
    {
      code: import_zod.z.string().describe('JavaScript function body. Receives (figma, params); may use await; `return` the result you want. E.g. "const n = await figma.getNodeByIdAsync(params.id); return { name: n.name, w: n.width };"'),
      params: import_zod.z.record(import_zod.z.unknown()).optional().describe("Optional JSON object passed to the script as `params`.")
    },
    async ({ code, params }) => {
      try {
        const result = await sendCommandToFigma("run_script", { code, params }, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error running Figma script: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_project_context",
    "Read the project's CONTEXT DOCUMENT \u2014 the Figma-side analogue of a code repo's CLAUDE.md, stored IN the Figma document itself (root sharedPluginData, so it follows the file across machines). It explains what the file structure MEANS: page purposes (e.g. a reference page holding competitor captures vs. actual in-progress designs), naming conventions, where each feature lives, and common misidentification traps. READ IT BEFORE interpreting search results or picking a screen as 'the' design. If the project has no context yet, the response includes outline material summarized from the search index \u2014 use it to DRAFT a structure guide and save it with set_project_context.",
    {
      project: import_zod.z.string().optional().describe("Project/document name or file key. Omit for the currently selected project. Passing a different project SWITCHES the current selection (same as use_figma_project).")
    },
    async ({ project }) => {
      try {
        if (project) await selectProject(project);
        const doc = await fetchProjectContextFromDocument();
        if (doc?.exists) {
          return { content: [{ type: "text", text: JSON.stringify({
            project: selectedProject?.name ?? null,
            fileName: doc.fileName ?? null,
            updatedAt: doc.updatedAt ?? null,
            updatedBy: doc.updatedBy ?? null,
            content: doc.content
          }, null, 2) }] };
        }
        const material = buildContextDraftMaterial(currentProjectKey());
        return { content: [{ type: "text", text: JSON.stringify({
          exists: false,
          project: selectedProject?.name ?? null,
          note: "\uC774 \uD504\uB85C\uC81D\uD2B8\uC5D0\uB294 \uCEE8\uD14D\uC2A4\uD2B8 \uBB38\uC11C\uAC00 \uC544\uC9C1 \uC5C6\uB2E4. \uD30C\uC77C \uAD6C\uC870\uB97C \uD30C\uC545\uD588\uB2E4\uBA74 \u2014 \uD398\uC774\uC9C0 \uC6A9\uB3C4, \uBA85\uBA85 \uADDC\uCE59, \uAE30\uB2A5\uBCC4 \uC704\uCE58, \uD754\uD55C \uC624\uC778 \uC9C0\uC810 \u2014 set_project_context \uB85C \uAE30\uB85D\uD558\uB77C.",
          ...material ? {
            draftMaterial: material,
            draftHint: "draftMaterial \uC740 \uB514\uC2A4\uD06C \uC778\uB371\uC2A4\uC5D0\uC11C \uBF51\uC740 \uD398\uC774\uC9C0 \uC544\uC6C3\uB77C\uC778 \uC694\uC57D\uC774\uB2E4(flags \uB294 \uC774\uB984 \uAE30\uBC18 \uD734\uB9AC\uC2A4\uD2F1 \uCD94\uC815). \uC774\uB97C \uC7AC\uB8CC\uB85C \uAD6C\uC870 \uAC00\uC774\uB4DC \uCD08\uC548\uC744 \uC791\uC131\uD574 set_project_context \uB85C \uC800\uC7A5\uD558\uB77C \u2014 \uB2E8\uC815\uD558\uC9C0 \uB9D0\uACE0 \uC2E4\uC81C \uD398\uC774\uC9C0 \uB0B4\uC6A9\uC744 \uD655\uC778\uD574 \uC11C\uC220\uD560 \uAC83."
          } : {}
        }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error getting project context: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "set_project_context",
    "Replace the project's CONTEXT DOCUMENT (full-document semantics; there is no partial patch \u2014 read with get_project_context, edit, then write the whole markdown back). Stored in the Figma document itself, so it syncs everywhere the file is opened. Record: page purposes (e.g. '\uB808\uD37C\uB7F0\uC2A4 \uD398\uC774\uC9C0 = \uD0C0\uC0AC \uCEA1\uCC98 \uBAA8\uC74C, \uC6B0\uB9AC \uB514\uC790\uC778 \uC544\uB2D8' vs '\uC791\uC5C5 \uC911 = \uC9C4\uD589 \uB514\uC790\uC778'), naming conventions, where each feature's screens live, and common misidentification traps. When the operator gives feedback that something was found WRONG (\uC798\uBABB \uCC3E\uC558\uB2E4), update this document with that lesson so the next agent does not repeat the mistake. Max 50KB UTF-8. An empty string clears the document.",
    {
      content: import_zod.z.string().describe("The full markdown context document (replaces the previous one; the previous document is what get_project_context returned). Empty string clears it."),
      project: import_zod.z.string().optional().describe("Project/document name or file key. Omit for the currently selected project. Passing a different project SWITCHES the current selection (same as use_figma_project).")
    },
    async ({ content, project }) => {
      try {
        if (project) await selectProject(project);
        const result = await sendCommandToFigma("set_project_context", { content }, 15e3);
        const projectKey = currentProjectKey();
        if (projectKey) {
          if (result?.cleared) clearCachedProjectContext(projectKey);
          else if (result?.saved) cacheProjectContext(projectKey, { content, updatedAt: result.updatedAt ?? null, updatedBy: result.updatedBy ?? null });
        }
        return { content: [{ type: "text", text: JSON.stringify({ ...result, project: selectedProject?.name ?? null }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error setting project context: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_file_outline",
    "Get an outline of the ENTIRE file in one call: every page with its top-level children (id, name, type). Replaces calling get_document_info once per page. Children are capped at 200 per page (marked truncated). NOTE: this loads every page in the file, which can take tens of seconds on large files the first time. If you are looking for something by name, prefer search_nodes.",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_file_outline", {}, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error getting file outline: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "set_current_page",
    "Switch Figma's current page to the given pageId. Every current-page-scoped tool (scan, selection, etc.) then operates on that page.",
    {
      pageId: import_zod.z.string().describe("The page id to switch to (from list_pages).")
    },
    async ({ pageId }) => {
      try {
        const result = await sendCommandToFigma("set_current_page", { pageId });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error setting current page: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "diagnose_pages",
    "Scan every page and report which pages have a node this plugin API can't classify (the cause of 'Unknown node type \u2026 getPublicNodeType' errors). For each unreadable page it returns the container(s) whose children couldn't be read, and best-effort tries a REST export of those containers to surface the offending child node's id/name/type. Use this to find what node is breaking reads.",
    {
      tryExport: import_zod.z.boolean().optional().describe("Try a REST export of each skipped container to identify the offending child type (default true)."),
      deep: import_zod.z.boolean().optional().describe("Also recurse below readable containers to find deeply-nested unclassifiable nodes (slower; default false checks only each page's direct children).")
    },
    async ({ tryExport, deep }) => {
      try {
        const result = await sendCommandToFigma("diagnose_pages", { tryExport: tryExport !== false, deep: !!deep }, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error diagnosing pages: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_node_by_key",
    "Resolve a design-system `key` (component, component set, or style key from get_design_system_info / get_local_components) to a live node id, so you can go straight from a catalog key to get_node_info or export. Tries local components first; for a published key not found locally it falls back to importing the asset into the file (importComponentByKeyAsync/importStyleByKeyAsync) \u2014 a read with a small side effect (the library asset becomes referenced in this file). Returns { found, id, type, remote, source, ... }.",
    {
      key: import_zod.z.string().describe("The component/style key to resolve.")
    },
    async ({ key }) => {
      try {
        const result = await sendCommandToFigma("get_node_by_key", { key });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error resolving key: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_design_system_info",
    "Get the full design-system catalog of the current file: components & component sets, paint/text/effect/grid styles, and Variables (with collections, modes, and per-mode values). Every item includes its `key` \u2014 the identifier shared with consuming files for a published library asset. Run this on the Foundation/library file to build the catalog you match Product references against. Unlike get_styles, this includes Variables (color tokens).",
    {
      includeVariableValues: import_zod.z.boolean().optional().describe("Include each variable's resolved value per mode (default true)."),
      resolveNames: import_zod.z.boolean().optional().describe("Include human-readable names (default true).")
    },
    async ({ includeVariableValues, resolveNames }) => {
      try {
        const result = await sendCommandToFigma("get_design_system_info", {
          includeVariableValues: includeVariableValues !== false,
          resolveNames: resolveNames !== false
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error getting design system info: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_nodes_design_info",
    "For specific node IDs, return what each node references in the design system: for INSTANCEs the main component (key, remote flag, component-set key), any fill/stroke/text/effect/grid STYLE references (key, remote), and any bound VARIABLES per property (key, resolvedType). Use the keys to match against get_design_system_info from the Foundation file. Missing/raw values are omitted (a node with no `component`/`styles`/`boundVariables` uses no tokens there).",
    {
      nodeIds: import_zod.z.array(import_zod.z.string()).describe("Node IDs to inspect"),
      resolveNames: import_zod.z.boolean().optional().describe("Include human-readable names (default true).")
    },
    async ({ nodeIds, resolveNames }) => {
      try {
        const result = await sendCommandToFigma("get_nodes_design_info", {
          nodeIds,
          resolveNames: resolveNames !== false
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error getting node design info: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "scan_design_usage",
    "Scan a node subtree (chunked) and return an AGGREGATED design-system usage summary: instances grouped by main-component key (with remote/local/detached counts), style references grouped by style key per slot, variable bindings grouped by variable key, and a fill token-coverage signal (tokenizedOrStyled vs rawSolid). Built for large trees (~1000s of nodes) \u2014 returns counts + sample node IDs per key, not every node, unless includeNodes is set. Match the keys against get_design_system_info from the Foundation file to compute reuse rates.",
    {
      nodeId: import_zod.z.string().describe("Root node ID of the subtree to scan (e.g. a page or top frame)"),
      chunkSize: import_zod.z.number().int().positive().optional().describe("Nodes per chunk (default 200)."),
      includeNodes: import_zod.z.boolean().optional().describe("Also return a per-node list of nodes that reference the design system (default false; can be large)."),
      resolveNames: import_zod.z.boolean().optional().describe("Include human-readable names (default true).")
    },
    async ({ nodeId, chunkSize, includeNodes, resolveNames }) => {
      try {
        const result = await sendCommandToFigma("scan_design_usage", {
          nodeId,
          chunkSize: chunkSize || 200,
          includeNodes: !!includeNodes,
          resolveNames: resolveNames !== false
        }, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error scanning design usage: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  function publishBulk(job) {
    job.updatedAt = Date.now();
    if (ws?.readyState === import_ws.default.OPEN) {
      ws.send(JSON.stringify({
        type: "bulk_status",
        requesterId,
        job: {
          id: job.id,
          status: job.status,
          total: job.items.length,
          completed: job.completed,
          failed: job.failed,
          currentIndex: job.currentIndex,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt
        }
      }));
    }
  }
  async function runBulk(job) {
    job.status = "running";
    publishBulk(job);
    for (let index = 0; index < job.items.length; index++) {
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.currentIndex = null;
        publishBulk(job);
        return;
      }
      job.currentIndex = index;
      publishBulk(job);
      const item = job.items[index];
      try {
        const result = await sendCommandToFigma(item.command, { ...item.params || {}, batchId: job.id });
        job.results[index] = { ok: true, result };
        job.completed++;
      } catch (error) {
        job.results[index] = { ok: false, error: error instanceof Error ? error.message : String(error) };
        job.failed++;
      }
      publishBulk(job);
    }
    job.currentIndex = null;
    job.status = job.failed ? "error" : "completed";
    publishBulk(job);
  }
  server.tool(
    "list_figma_projects",
    "List connected Figma projects and every live plugin connection. The relay identifies a project by Figma file key, marks the most recently announced connection as representative, and recommends the least-loaded connection for new MCP clients. The response starts with a versions summary ({mcp, relay}); use get_versions for the full per-plugin version picture.",
    {},
    async () => {
      try {
        const payload = await relayProjectsPayload();
        return { content: [{ type: "text", text: JSON.stringify({
          versions: { mcp: PROTOCOL_VERSION, relay: payload.protocolVersion ?? null },
          current: selectedProject,
          projects: payload.projects || []
        }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error listing Figma projects: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_versions",
    "Report the protocol versions of every talk-to-figma surface: this MCP server, the relay, and each connected Figma plugin (per project/channel), plus whether any MAJOR versions mismatch. Use this first when behavior seems inconsistent between surfaces \u2014 a mismatch means one of them is running stale code.",
    {},
    async () => {
      try {
        const mcp = PROTOCOL_VERSION;
        let relay = null;
        let relayError;
        const plugins = [];
        try {
          const payload = await relayProjectsPayload();
          relay = payload.protocolVersion ?? null;
          for (const project of payload.projects || []) {
            for (const connection of project.connections || []) {
              for (const client of connection.clients || []) {
                if (client.role === "figma") {
                  plugins.push({ project: project.name, channel: connection.channel, protocolVersion: client.protocolVersion ?? null });
                }
              }
            }
          }
        } catch (error) {
          relayError = error instanceof Error ? error.message : String(error);
        }
        const majors = new Set(
          [mcp, relay, ...plugins.map((p) => p.protocolVersion)].map((v) => protocolMajor(v)).filter((m) => m !== null)
        );
        const result = { mcp, relay, plugins, mismatch: majors.size > 1 };
        if (relayError) result.relayError = relayError;
        if (result.mismatch) result.note = "MAJOR versions differ between surfaces \u2014 update/rebuild the stale one(s) and reconnect (the relay refuses mismatched clients at handshake, so a listed mismatch usually means a surface has not reconnected since an update).";
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error getting versions: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "use_figma_project",
    "Connect this MCP client to a Figma project by project name or file key. No channel name is needed; the least-loaded healthy plugin connection is selected automatically. The response includes the project's CONTEXT DOCUMENT (page purposes, naming conventions, feature locations, misidentification traps \u2014 stored in the Figma document itself); READ IT before interpreting anything in the file.",
    { project: import_zod.z.string().describe("Figma project/document name or file key") },
    async ({ project }) => {
      try {
        const selected = await selectProject(project);
        const CONTEXT_PREVIEW_LIMIT = 2e3;
        let projectContext = void 0;
        try {
          const doc = await fetchProjectContextFromDocument();
          if (doc?.exists && typeof doc.content === "string") {
            const truncated = doc.content.length > CONTEXT_PREVIEW_LIMIT;
            projectContext = {
              updatedAt: doc.updatedAt ?? null,
              updatedBy: doc.updatedBy ?? null,
              content: truncated ? doc.content.slice(0, CONTEXT_PREVIEW_LIMIT) : doc.content,
              ...truncated ? { truncated: true, note: "\uC804\uCCB4\uB294 get_project_context \uB85C \uC77D\uC5B4\uB77C." } : {}
            };
          } else {
            projectContext = {
              exists: false,
              note: "\uCEE8\uD14D\uC2A4\uD2B8 \uBB38\uC11C\uAC00 \uC544\uC9C1 \uC5C6\uB2E4 \u2014 \uD30C\uC77C \uAD6C\uC870\uB97C \uD30C\uC545\uD588\uB2E4\uBA74 set_project_context \uB85C \uAE30\uB85D\uD558\uB77C (get_project_context \uAC00 \uCD08\uC548 \uC7AC\uB8CC\uB97C \uC900\uB2E4)."
            };
          }
        } catch {
        }
        return { content: [{ type: "text", text: JSON.stringify({
          connected: true,
          project: selectedProject,
          connectionCount: selected.connectionCount,
          busy: selected.busy,
          ...projectContext !== void 0 ? { projectContext } : {}
        }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error selecting Figma project: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  server.tool(
    "get_figma_workload",
    "Show connected projects, plugin connection counts, active request counts, and queued work.",
    {},
    async () => {
      const projects = await relayProjects();
      return { content: [{ type: "text", text: JSON.stringify({ requesterId, current: selectedProject, projects }, null, 2) }] };
    }
  );
  server.tool(
    "start_bulk_operations",
    "Start a cancellable bulk job. Items run in order and progress is available immediately through get_bulk_operation; the dashboard groups all item progress under the returned bulk id.",
    {
      items: import_zod.z.array(import_zod.z.object({
        command: import_zod.z.string().describe("Figma command name"),
        params: import_zod.z.record(import_zod.z.unknown()).optional()
      })).min(1)
    },
    async ({ items }) => {
      const job = {
        id: (0, import_uuid.v4)(),
        status: "queued",
        items,
        completed: 0,
        failed: 0,
        currentIndex: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        results: [],
        cancelRequested: false
      };
      bulkJobs.set(job.id, job);
      publishBulk(job);
      void runBulk(job);
      return { content: [{ type: "text", text: JSON.stringify({ id: job.id, status: job.status, total: job.items.length }) }] };
    }
  );
  server.tool(
    "get_bulk_operation",
    "Get progress, per-item results, wait time, and execution time for a bulk job.",
    { id: import_zod.z.string() },
    async ({ id }) => {
      const job = bulkJobs.get(id);
      return { content: [{ type: "text", text: JSON.stringify(job || { error: "Bulk job not found", id }, null, 2) }] };
    }
  );
  server.tool(
    "cancel_bulk_operation",
    "Cancel a bulk job at the next item boundary. The currently executing Figma command is allowed to finish safely; remaining items will not start.",
    { id: import_zod.z.string() },
    async ({ id }) => {
      const job = bulkJobs.get(id);
      if (!job) return { content: [{ type: "text", text: JSON.stringify({ error: "Bulk job not found", id }) }] };
      job.cancelRequested = true;
      if (job.status === "queued" || job.status === "running") job.status = "cancelling";
      publishBulk(job);
      return { content: [{ type: "text", text: JSON.stringify({ id, status: job.status }) }] };
    }
  );
  server.tool(
    "list_figma_channels",
    "List the channels on the Talk-to-Figma relay server and which Figma document each is connected to. Use this BEFORE join_channel when you don't already know the channel name: find the channel whose document matches what the user wants, then call join_channel with it. Channels where hasFigma is true have a live Figma plugin and are joinable; empty channels are kept for history and show which document they were. Returns the currently joined channel as `current`.",
    {},
    async () => {
      try {
        const httpUrl = relayHttpUrl("channels");
        const res = await fetch(httpUrl);
        if (!res.ok) throw new Error(`relay returned HTTP ${res.status}`);
        const data = await res.json();
        const channels = (data.channels || []).map((c) => ({
          channel: c.channel,
          active: !c.empty,
          hasFigma: (c.clients || []).some((cl) => cl.role === "figma"),
          clientRoles: (c.clients || []).map((cl) => cl.role),
          busy: c.busy,
          runningRequests: c.runningRequests || 0,
          pendingRequests: c.pendingRequests || 0,
          clients: (c.clients || []).map((cl) => ({
            id: cl.id,
            role: cl.role,
            deviceName: cl.deviceName,
            connectionScope: cl.connectionScope,
            address: cl.address,
            runningRequests: cl.runningRequests || 0,
            pendingRequests: cl.pendingRequests || 0
          })),
          document: c.document ? {
            name: c.document.documentName,
            page: c.document.page,
            nodeCount: c.document.nodeCount,
            pageCount: c.document.pageCount,
            fileKey: c.document.fileKey
          } : null,
          emptiedAt: c.emptiedAt
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ current: currentChannel, channels }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing channels: ${error instanceof Error ? error.message : String(error)}. Is the WebSocket relay running (bun socket) on port 3055?`
            }
          ]
        };
      }
    }
  );
  server.tool(
    "join_channel",
    "Join a specific channel to communicate with Figma",
    {
      channel: import_zod.z.string().describe("The name of the channel to join").default("")
    },
    async ({ channel }) => {
      try {
        if (!channel) {
          return {
            content: [
              {
                type: "text",
                text: "Please provide a channel name to join:"
              }
            ],
            followUp: {
              tool: "join_channel",
              description: "Join the specified channel"
            }
          };
        }
        await joinChannel(channel);
        return {
          content: [
            {
              type: "text",
              text: `Successfully joined channel: ${channel}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  try {
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn("Will try to connect when the first command is sent");
  }
  const dispose = () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const request of pendingRequests.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("MCP session closed"));
    }
    pendingRequests.clear();
    if (ws) {
      const socket = ws;
      ws = null;
      socket.removeAllListeners();
      socket.on("error", () => void 0);
      socket.terminate();
    }
  };
  return { server, dispose };
}
var runtimeArgs = process.argv.slice(2);
var httpMode = runtimeArgs.includes("--http");
var httpPort = Number(runtimeArgs.find((arg) => arg.startsWith("--port="))?.split("=")[1] || 3056);
var httpHost = runtimeArgs.find((arg) => arg.startsWith("--host="))?.split("=")[1] || "127.0.0.1";
var exportDirectory = process.env.FIGMA_EXPORT_DIR || path5.join(os5.homedir(), ".macfleet", "figma-exports");
var configuredExportTTLHours = Number(process.env.FIGMA_EXPORT_TTL_HOURS || 24);
var exportTTLHours = Number.isFinite(configuredExportTTLHours) && configuredExportTTLHours > 0 ? configuredExportTTLHours : 24;
var exportTTL = exportTTLHours * 60 * 60 * 1e3;
var exportNamePattern = /^[0-9a-f-]{36}\.(png|jpg|svg|pdf)$/;
function cleanupExports() {
  if (!fs5.existsSync(exportDirectory)) return;
  const cutoff = Date.now() - exportTTL;
  for (const name of fs5.readdirSync(exportDirectory)) {
    if (!exportNamePattern.test(name)) continue;
    const file = path5.join(exportDirectory, name);
    try {
      if (fs5.statSync(file).mtimeMs < cutoff) fs5.unlinkSync(file);
    } catch (error) {
      logger.warn(`Could not clean export ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
function exportContentType(name) {
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".pdf")) return "application/pdf";
  return "image/png";
}
function serveExport(req, res, pathname) {
  if (!pathname.startsWith("/files/")) return false;
  const name = pathname.slice("/files/".length);
  if (!exportNamePattern.test(name)) {
    res.writeHead(404).end("not found");
    return true;
  }
  const file = path5.join(exportDirectory, name);
  try {
    const stat = fs5.statSync(file);
    if (!stat.isFile() || Date.now() - stat.mtimeMs > exportTTL) {
      if (stat.isFile()) fs5.unlinkSync(file);
      res.writeHead(404).end("not found");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": exportContentType(name),
      "Content-Length": stat.size,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    fs5.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
  return true;
}
async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 10 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function startHTTPServer() {
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`Invalid --port: ${httpPort}`);
  }
  fs5.mkdirSync(exportDirectory, { recursive: true, mode: 448 });
  cleanupExports();
  const cleanupTimer = setInterval(cleanupExports, Math.min(exportTTL, 60 * 60 * 1e3));
  cleanupTimer.unref();
  const configuredBase = process.env.NEXUS_TUNNEL_PUBLIC_BASE || process.env.BROKER_PUBLIC_BASE;
  const remoteExportBase = (configuredBase || `http://${httpHost}:${httpPort}`).replace(/\/$/, "");
  const sessions = /* @__PURE__ */ new Map();
  const httpServer = (0, import_http.createServer)(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
      if (req.method === "GET" && serveExport(req, res, pathname)) return;
      if (pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname !== "/mcp") {
        res.writeHead(404).end("not found");
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let entry = sessionId ? sessions.get(sessionId) : void 0;
      let body;
      if (req.method === "POST") body = await readJSON(req);
      if (!entry && req.method === "POST" && !sessionId && (0, import_types.isInitializeRequest)(body)) {
        let transport;
        const { server: mcpServer, dispose } = createMcpServer({ remoteExportBase });
        transport = new import_streamableHttp.StreamableHTTPServerTransport({
          sessionIdGenerator: import_uuid.v4,
          onsessioninitialized: (id) => sessions.set(id, { transport, server: mcpServer, dispose })
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          dispose();
        };
        await mcpServer.connect(transport);
        entry = { transport, server: mcpServer, dispose };
      }
      if (!entry) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32e3, message: "Invalid or missing MCP session" },
          id: null
        }));
        return;
      }
      await entry.transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  await new Promise((resolve2, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(httpPort, httpHost, resolve2);
  });
  logger.info(`FigmaMCP Streamable HTTP server listening on http://${httpHost}:${httpPort}/mcp`);
}
async function main() {
  if (httpMode) {
    await startHTTPServer();
    return;
  }
  const { server } = createMcpServer();
  const transport = new import_stdio.StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaMCP server running on stdio");
}
main().catch((error) => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
//# sourceMappingURL=server.cjs.map