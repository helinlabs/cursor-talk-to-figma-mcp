#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { captureLocalFigmaWindow } from "../local-figma-capture";
import {
  type SearchAnnotation,
  normalizeKeywordKey,
  upsertSearchAnnotation,
  removeSearchAnnotations,
  findAnnotationsForKeys,
} from "../shared/annotations-store";
import {
  loadProjectIndex,
  buildNeedles,
  findNormalizedMatch,
  textMatchSnippet,
} from "../shared/search-index";
import {
  cacheProjectContext,
  clearCachedProjectContext,
  hasCachedProjectContext,
} from "../shared/project-context";
import { loadRelayErrors } from "../shared/errors-store";

import { PROTOCOL_VERSION, protocolMajor } from "../shared/version";
const BINARY_MAGIC = Buffer.from([0x54, 0x54, 0x46, 0x42]); // "TTFB"

function rawDataToBuffer(data: any): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map(rawDataToBuffer));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

function decodeBinaryFrame(data: any): { envelope: any; payload: Buffer } {
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

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

type McpServerOptions = {
  remoteExportBase?: string;
};

// ---------------------------------------------------------------------------
// Persisted state (survives MCP server restarts, e.g. client reconnects).
// ---------------------------------------------------------------------------
type SelectedProject = { projectKey: string; name: string; fileKey?: string | null };

const STATE_DIR = path.join(os.homedir(), ".talk-to-figma");
const STATE_FILE = path.join(STATE_DIR, "state.json");

function loadPersistedSelectedProject(): SelectedProject | null {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const project = raw?.selectedProject;
    if (project && typeof project === "object" && typeof project.name === "string") {
      return {
        projectKey: String(project.projectKey || ""),
        name: project.name,
        fileKey: project.fileKey ?? null,
      };
    }
  } catch (error) {
    // Missing/corrupt state file is fine — start unselected.
  }
  return null;
}

function persistSelectedProject(project: SelectedProject | null): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ selectedProject: project }, null, 2));
  } catch (error) {
    // Persistence is best-effort; never fail a command over it.
    logger.warn(`Could not persist selected project: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createMcpServer(options: McpServerOptions = {}) {
// WebSocket connection and request tracking
let ws: WebSocket | null = null;
let disposed = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number; // Add timestamp for last activity
  command: string;
  channel: string | null;
}>();

// Track which channel each client is in
let currentChannel: string | null = null;
let desiredChannel: string | null = null;
let selectedProject: SelectedProject | null = loadPersistedSelectedProject();
let fatalProtocolError: string | null = null;
const requesterId =
  process.env.TALK_TO_FIGMA_REQUESTER_ID ||
  process.env.CODEX_THREAD_ID ||
  process.env.CURSOR_SESSION_ID ||
  `mcp-${process.pid}`;

interface BulkItem {
  command: FigmaCommand;
  params?: Record<string, unknown>;
}

interface BulkJob {
  id: string;
  status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "error";
  items: BulkItem[];
  completed: number;
  failed: number;
  currentIndex: number | null;
  createdAt: number;
  updatedAt: number;
  results: any[];
  cancelRequested: boolean;
}

const bulkJobs = new Map<string, BulkJob>();

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: PROTOCOL_VERSION,
});

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find(arg => arg.startsWith('--server='));
const serverUrl = serverArg ? serverArg.slice('--server='.length) : 'localhost';

function normalizeRelayWebSocketUrl(value: string): string {
  const target = value.trim() || "localhost";
  if (target === "localhost") return "ws://localhost:3055";
  if (/^wss?:\/\//i.test(target)) return target;
  if (/^https?:\/\//i.test(target)) return target.replace(/^http/i, "ws");
  return `wss://${target}`;
}

const RELAY_WS_URL = normalizeRelayWebSocketUrl(serverUrl);

function relayHttpUrl(endpoint: string): string {
  const url = new URL(RELAY_WS_URL);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
  return url.toString();
}

async function saveToRelayGallery(bytes: Uint8Array | string, suggestedName: string, extension: string): Promise<any> {
  const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  const response = await fetch(relayHttpUrl("exports"), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Figma-Export-Name": encodeURIComponent(suggestedName),
      "X-Figma-Export-Extension": extension,
    },
    body,
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Gallery upload failed with HTTP ${response.status}`);
  return result;
}

// Document Info Tool
server.tool(
  "get_document_info",
  "Get information about a Figma page: its top-level nodes plus a list of all pages in the file (so non-open pages are discoverable). Pass `pageId` to inspect a specific page without switching to it. If you know (part of) the name of what you're looking for, use search_nodes first instead of inspecting pages one by one; for a one-call overview of all pages use get_file_outline.",
  {
    pageId: z.string().optional().describe("Inspect this page instead of the current one (see list_pages for ids)."),
  },
  async ({ pageId }: any) => {
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
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Selection Tool
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
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Read My Design Tool
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
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Info Tool
server.tool(
  "get_node_info",
  "Get detailed information about a specific node in Figma. For large/deep nodes, pass `fields` to return only the properties you need and/or `maxDepth` to limit how deep the child tree is expanded (a 900K-char section becomes a few KB). When children are omitted (depth/field limit) a `childCount` is included so you know to drill deeper.",
  {
    nodeId: z.string().describe("The ID of the node to get information about"),
    fields: z.array(z.string()).optional().describe("Only return these top-level fields (id/name/type are always included). e.g. ['fills','characters','style','absoluteBoundingBox','componentProperties','children']. Omit 'children' to get just this node."),
    maxDepth: z.number().int().min(0).optional().describe("Max levels of children to expand. 0 = this node only, 1 = direct children, etc. Omit for the full subtree."),
    includeHash: z.boolean().optional().describe("Also return a stable `subtreeHash` covering the subtree's structure, text, bound tokens, and sizes. Same content → same hash; useful for detecting which screens changed between runs."),
  },
  async ({ nodeId, fields, maxDepth, includeHash }: any) => {
    try {
      // The plugin already filters/shapes the node; return it directly.
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
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Note: node shaping (filtering, hex conversion, field/depth selection) now
// happens entirely in the plugin (see filterFigmaNode in code.js). The MCP
// server returns the plugin's already-shaped node as-is, so the previous
// server-side filterFigmaNode/rgbaToHex pass (a redundant second filter that
// could corrupt already-hex'd colors) has been removed.

// Nodes Info Tool
server.tool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma. Supports the same `fields` / `maxDepth` shaping as get_node_info to keep responses small.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get information about"),
    fields: z.array(z.string()).optional().describe("Only return these top-level fields (id/name/type always included)."),
    maxDepth: z.number().int().min(0).optional().describe("Max levels of children to expand (0 = node only)."),
    includeHash: z.boolean().optional().describe("Also return a stable `subtreeHash` per node (see get_node_info)."),
  },
  async ({ nodeIds, fields, maxDepth, includeHash }: any) => {
    try {
      const results = await Promise.all(
        nodeIds.map(async (nodeId: any) => {
          const result = await sendCommandToFigma('get_node_info', { nodeId, fields, maxDepth, includeHash });
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
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);


// Frame Context Tool — one-shot, RN-ready digest of a screen subtree
server.tool(
  "get_frame_context",
  "Get a single, pruned, RN-ready digest of a frame's subtree — replaces the get_node_info + scan_text_nodes + get_nodes_design_info round-trips. OS chrome (Status Bar / Home Indicator / Keyboard / Notch / Dynamic Island) and hidden nodes are dropped; each remaining node carries only relative bounds, text + typography, flex-friendly layout (flexDirection/gap/padding/justify/align), resolved semantic tokens (fill/stroke/radius/textStyle…), and a hasImageFill flag. Call it on a screen frame and write the spec from the one response. For very deep/large screens, pass `maxDepth` to cap traversal — nodes cut off by the limit still appear but carry `childCount` + `truncated: true` so you can drill into them with a follow-up call.",
  {
    nodeId: z.string().describe("The ID of the frame/screen node to digest"),
    excludeChrome: z.boolean().optional().describe("Drop OS chrome + hidden nodes (default true). Set false to keep everything."),
    chromeNames: z.array(z.string()).optional().describe("Override the default chrome name list (case-insensitive substring match)."),
    includeHash: z.boolean().optional().describe("Also include a stable `subtreeHash` at the root for change detection."),
    maxDepth: z.number().int().min(0).optional().describe("Max levels of children to digest. 0 = root only, 1 = direct children, etc. Omit for the full subtree. Use this when a deep screen makes the response too large or times out."),
  },
  async ({ nodeId, excludeChrome, chromeNames, includeHash, maxDepth }: any) => {
    try {
      const result = await sendCommandToFigma("get_frame_context", {
        nodeId,
        excludeChrome: excludeChrome === undefined ? true : excludeChrome,
        chromeNames,
        includeHash: !!includeHash,
        maxDepth,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting frame context: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);


// Create Rectangle Tool
server.tool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Frame Tool
server.tool(
  "create_frame",
  "Create a new frame in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: z
      .number()
      .optional()
      .describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
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
  }: any) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor: strokeColor,
        strokeWeight: strokeWeight,
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
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Text Tool
server.tool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Semantic layer name for the text node"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Fill Color Tool
server.tool(
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
  },
  async ({ nodeId, r, g, b, a }: any) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Image Fill From Node Tool
server.tool(
  "set_image_fill_from_node",
  "Swap the picture inside another node: exports `sourceNodeId` as PNG and puts it in `targetNodeId`'s IMAGE fill. " +
  "Both steps run inside the plugin, so no image bytes cross the socket (a screenshot is megabytes — base64 over the relay hits message limits). " +
  "**Geometry is inherited, not rebuilt.** If the target already has an IMAGE fill, only its `imageHash` changes — `scaleMode`, `imageTransform`, rotation and filters are kept. " +
  "That matters for device mockups: the screen slot is an axis-aligned node whose tilt lives in the paint's `imageTransform`, so building a fresh paint would leave an upright screenshot merely cropped to a slanted path, not matching the device angle. " +
  "The target's own transform (rotation, masks) is untouched either way, since only `fills` is written. " +
  "Typical use: drop a localized app-screen frame into a mockup's `Paste content here` slot. " +
  "⚠️ Enumerate a mockup's children with `scan_nodes_by_types`, not `get_node_info` — mask layers are omitted from `children`, so the real content slot can be invisible there.",
  {
    sourceNodeId: z.string().describe("Node to render (e.g. a live app-screen frame)"),
    targetNodeId: z.string().describe("Node whose picture is replaced — the mockup's content slot, NOT its mask"),
    scale: z.number().positive().optional().describe("Export scale for the source render (default 2). Figma rejects images over 4096px on a side, so keep width*scale and height*scale under that."),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Fill mode for a NEW paint. Ignored when inheriting — overriding it would make Figma drop the imageTransform and flatten a mockup's tilt. Pair with replacePaint to force it."),
    replacePaint: z.boolean().optional().describe("Discard the existing paint instead of inheriting it. Drops imageTransform — only for slots that have no geometry to keep."),
  },
  async ({ sourceNodeId, targetNodeId, scale, scaleMode, replacePaint }: any) => {
    try {
      const result = await sendCommandToFigma("set_image_fill_from_node", {
        sourceNodeId,
        targetNodeId,
        scale: scale || 2,
        scaleMode,
        replacePaint: replacePaint || false,
      });
      const typed = result as {
        sourceName: string; targetName: string; bytes: number; scaleMode: string;
        inheritedGeometry: { scaleMode: string; hasImageTransform: boolean } | null;
      };
      const geom = typed.inheritedGeometry
        ? `inherited ${typed.inheritedGeometry.scaleMode}${typed.inheritedGeometry.hasImageTransform ? " + imageTransform" : ""}`
        : "new paint (no geometry inherited — check the device angle)";
      return {
        content: [
          {
            type: "text",
            text: `Swapped "${typed.sourceName}" into "${typed.targetName}" (${typed.bytes} bytes, ${typed.scaleMode}, ${geom}).`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting image fill: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Get Node Geometry Tool
server.tool(
  "get_node_geometry",
  "Read a node's size, rotation, vector vertices and existing image-fill geometry. " +
  "Use it to get the four corners of a device mockup's slanted screen slot (a 4-point VECTOR, often named 'Paste content here') — " +
  "`get_node_info` does not return vector paths. Coordinates come back in NODE-LOCAL space (0..width, 0..height), the same space an image fill is painted into, " +
  "so a quad warped to those points drops straight in.",
  {
    nodeId: z.string().describe("Node to measure — usually the mockup's screen slot vector"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_node_geometry", { nodeId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading geometry: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Image Fill From Bytes Tool
server.tool(
  "set_image_fill_from_bytes",
  "Put an already-prepared PNG (base64) into a node's IMAGE fill. " +
  "**Figma cannot skew**, so a screenshot that has to match a tilted device must be perspective-warped OUTSIDE Figma (PIL/OpenCV) — this is how the result gets back in. " +
  "`set_image_fill_from_node` bakes inside the plugin and therefore cannot warp; use that one for upright slots and this one for slanted mockups. " +
  "Existing paint geometry is inherited (only `imageHash` changes) unless `replacePaint` is set. " +
  "⚠️ Bytes travel over the relay — send one warped image per call, not a batch. Figma rejects images over 4096px on a side.",
  {
    nodeId: z.string().describe("Node whose image fill is replaced"),
    imageBase64: z.string().describe("PNG bytes, base64-encoded, already warped to the target quad"),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Only used when creating a new paint (no existing image fill, or replacePaint)"),
    replacePaint: z.boolean().optional().describe("Discard the existing paint instead of inheriting it"),
  },
  async ({ nodeId, imageBase64, scaleMode, replacePaint }: any) => {
    try {
      const result = await sendCommandToFigma("set_image_fill_from_bytes", {
        nodeId, imageBase64, scaleMode, replacePaint: replacePaint || false,
      });
      const typed = result as { name: string; bytes: number; scaleMode: string; inherited: boolean };
      return {
        content: [{ type: "text", text: `Filled "${typed.name}" with ${typed.bytes} bytes (${typed.scaleMode}, ${typed.inherited ? "inherited paint" : "new paint"}).` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting image fill: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Stroke Color Tool
server.tool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({ nodeId, r, g, b, a, weight }: any) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Move Node Tool
server.tool(
  "move_node",
  "Move a node to a new position in Figma",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().describe("New X position"),
    y: z.number().describe("New Y position"),
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma. Pass `name` to rename the clone in the same call — a clone inherits the original's name, so cloning a whole language row (DE_01..08 → IT_01..08) otherwise leaves every frame called DE_*.",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone"),
    name: z.string().optional().describe("Name for the clone (defaults to the original's name)"),
    parentId: z.string().optional().describe("Container to append the clone to. Without it the clone lands beside the ORIGINAL — which drops a stray copy into another page/section when cloning across containers.")
  },
  async ({ nodeId, x, y, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma('clone_node', { nodeId, x, y, name, parentId });
      const typedResult = result as { name: string, id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ''}`
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

// Rename nodes. Layer names are how downstream scripts pick assets out of a file
// (the store uploader looks for `IT_03`), and FRAME/GROUP names do not follow their
// contents the way TEXT names do — so a cloned row needs an explicit rename pass.
server.tool(
  "set_node_names",
  "Rename one or more nodes. Use after cloning a language row so the copies stop carrying the source language's names.",
  {
    names: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to rename"),
          name: z.string().describe("The new layer name"),
        })
      )
      .describe("Nodes to rename")
  },
  async ({ names }: any) => {
    try {
      const result = await sendCommandToFigma('set_node_names', { names });
      const typedResult = result as { renamed: number; results: any[] };
      const failures = typedResult.results.filter((r) => !r.success);
      return {
        content: [
          {
            type: "text",
            text: `Renamed ${typedResult.renamed}/${typedResult.results.length} nodes` +
              (failures.length ? `\nFailed: ${JSON.stringify(failures)}` : '')
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

// Copy an IMAGE fill (hash + paint geometry) between nodes. Mask nodes export as a
// 1x1 transparent PNG, so a device mockup's rounded-corner screen mask cannot be
// pulled out as bytes — the only way to restore one is to carry the hash across.
server.tool(
  "copy_image_fill",
  "Copy an IMAGE fill from one node to another, preserving imageHash and paint geometry. Use when the fill cannot be re-exported (e.g. a mask node, which exports as 1x1 transparent).",
  {
    sourceNodeId: z.string().describe("Node to copy the IMAGE fill from"),
    targetNodeId: z.string().describe("Node whose fills are replaced"),
    fillIndex: z.number().optional().describe("Which IMAGE fill to take when the source has several (default 0)")
  },
  async ({ sourceNodeId, targetNodeId, fillIndex }: any) => {
    try {
      const result = await sendCommandToFigma('copy_image_fill', { sourceNodeId, targetNodeId, fillIndex });
      const t = result as { imageHash: string; scaleMode: string };
      return { content: [{ type: "text", text: `Copied image fill ${t.imageHash} (${t.scaleMode}) to ${targetNodeId}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error copying image fill: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Sections are the only way to declare "this block belongs together" on the canvas.
// Unlike a frame they neither reparent-shift child coordinates nor paint a background,
// so existing artwork can be grouped without being visually altered.
server.tool(
  "create_section",
  "Create a SECTION on the current page. Use to group a block of work without the clipping/background a FRAME would impose.",
  {
    name: z.string().describe("Section name"),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Section width"),
    height: z.number().describe("Section height")
  },
  async ({ name, x, y, width, height }: any) => {
    try {
      const r = await sendCommandToFigma('create_section', { name, x, y, width, height }) as { id: string };
      return { content: [{ type: "text", text: `Created section "${name}" (${r.id}) at (${x}, ${y}) ${width}x${height}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error creating section: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Promote a node to a COMPONENT so edits to it propagate to every instance.
// Only worth it when the same layout is stamped many times and must stay in sync;
// a plain clone is simpler when each copy is meant to drift.
server.tool(
  "create_component_from_node",
  "Turn an existing node into a COMPONENT in place. Instances of it then follow edits to the master while keeping their own text overrides.",
  {
    nodeId: z.string().describe("Node to promote"),
    name: z.string().optional().describe("Name for the component")
  },
  async ({ nodeId, name }: any) => {
    try {
      const r = await sendCommandToFigma('create_component_from_node', { nodeId, name }) as { id: string; name: string; alreadyComponent?: boolean };
      return { content: [{ type: "text", text: r.alreadyComponent ? `Node ${nodeId} is already a component (${r.name})` : `Created component "${r.name}" (${r.id})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error creating component: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Per-range text styling. Assigning `node.characters` smears the FIRST character's style
// over the whole string, so any title that mixes sizes (a big headline plus a small hashtag
// in one node) silently flattens when its text is replaced. Read segments before, write after.
server.tool(
  "get_text_segments",
  "Read a text node's per-range styles (fontSize, fontName, fills, ...). Use before replacing text that mixes styles within one node.",
  { nodeId: z.string().describe("Text node to read") },
  async ({ nodeId }: any) => {
    try {
      const r = await sendCommandToFigma('get_text_segments', { nodeId });
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
    nodeId: z.string().describe("Text node to write"),
    segments: z.array(z.object({
      characters: z.string(),
      fontSize: z.number().optional(),
      fontName: z.object({ family: z.string(), style: z.string() }).optional(),
      fills: z.array(z.any()).optional(),
      lineHeight: z.any().optional(),
      letterSpacing: z.any().optional(),
      textCase: z.string().optional(),
      textDecoration: z.string().optional(),
    })).describe("Ordered runs; concatenated characters become the new content")
  },
  async ({ nodeId, segments }: any) => {
    try {
      const r = await sendCommandToFigma('set_text_segments', { nodeId, segments }) as { segments: number };
      return { content: [{ type: "text", text: `Set ${r.segments} styled segment(s) on ${nodeId}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error setting text segments: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// RTL locales (Arabic, Hebrew) need the horizontal reading order flipped, not just the text.
// Auto-layout rows are ordered by child order; absolutely-positioned containers by x —
// mirroring the wrong one silently does nothing, so the tool picks per container by default.
server.tool(
  "mirror_horizontal",
  "Mirror a container's horizontal arrangement for RTL. Reverses child order in a horizontal auto-layout, or mirrors child x positions in an absolute container.",
  {
    nodeId: z.string().describe("Container to mirror"),
    mode: z.enum(["auto", "order", "position"]).optional().describe("auto (default) picks by layoutMode")
  },
  async ({ nodeId, mode }: any) => {
    try {
      const r = await sendCommandToFigma('mirror_horizontal', { nodeId, mode }) as { mode: string; count: number };
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
    nodeId: z.string().describe("Text node"),
    horizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
    vertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional()
  },
  async ({ nodeId, horizontal, vertical }: any) => {
    try {
      const r = await sendCommandToFigma('set_text_align', { nodeId, horizontal, vertical }) as any;
      return { content: [{ type: "text", text: `Aligned ${nodeId}: ${r.textAlignHorizontal}/${r.textAlignVertical}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error aligning text: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Figma refuses both reordering and repositioning of an instance's children, so RTL work
// on an instance is impossible without detaching. Editing the main component instead would
// change every language at once, which is not what a single-locale asset wants.
server.tool(
  "detach_instance",
  "Detach an INSTANCE into a plain frame so its children can be reordered or repositioned (e.g. for RTL mirroring).",
  { nodeId: z.string().describe("Instance to detach") },
  async ({ nodeId }: any) => {
    try {
      const r = await sendCommandToFigma('detach_instance', { nodeId }) as { id: string; detached: boolean; type: string };
      return { content: [{ type: "text", text: r.detached ? `Detached ${nodeId} -> ${r.id}` : `${nodeId} is ${r.type}, not an instance` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error detaching: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// SSOT 를 파일이 아니라 문서 자체에 두기 위한 것. sharedPluginData 라 위젯·다른 플러그인도
// 같은 네임스페이스로 읽고 쓸 수 있다(setPluginData 는 쓴 플러그인만 읽는다).
server.tool(
  "set_node_data",
  "Store JSON/text on a node as shared plugin data. Use to keep a single source of truth (translations, generation params) inside the Figma document itself.",
  {
    nodeId: z.string().describe("Node to attach data to (a SECTION works well)"),
    key: z.string().describe("Entry key, e.g. 'config' or 'listing:it'"),
    value: z.string().describe("Serialized value (JSON string)"),
    namespace: z.string().optional().describe("Shared namespace, default 'gymwork_aso'")
  },
  async ({ nodeId, key, value, namespace }: any) => {
    try {
      const r = await sendCommandToFigma('set_node_data', { nodeId, key, value, namespace }) as any;
      return { content: [{ type: "text", text: `${r.key}: ${r.bytes}B 저장${r.truncated ? ' ⚠️ 잘림 (' + r.stored + 'B)' : ''}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "get_node_data",
  "Read shared plugin data from a node. Omit `key` to list every key and value in the namespace.",
  {
    nodeId: z.string().describe("Node to read from"),
    key: z.string().optional().describe("Entry key; omit to get all"),
    namespace: z.string().optional().describe("Shared namespace, default 'gymwork_aso'")
  },
  async ({ nodeId, key, namespace }: any) => {
    try {
      const r = await sendCommandToFigma('get_node_data', { nodeId, key, namespace });
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
    nodeId: z.string().describe("Node"),
    key: z.string().describe("Entry key to remove"),
    namespace: z.string().optional().describe("Shared namespace, default 'gymwork_aso'")
  },
  async ({ nodeId, key, namespace }: any) => {
    try {
      await sendCommandToFigma('delete_node_data', { nodeId, key, namespace });
      return { content: [{ type: "text", text: `삭제: ${key}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Resize Node Tool
server.tool(
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
  },
  async ({ nodeId, width, height }: any) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
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
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Export Node as Image Tool
server.tool(
  "export_node_as_image",
  "Export a node as an image from Figma. If `outputPath` is given, the bytes are written to that file on disk (parent dirs auto-created) and the tool returns the saved path + dimensions. Without `outputPath`, stdio mode returns the image inline while HTTP mode returns an authenticated tunnel download URL with a finite TTL. The exported SVG always carries REAL, renderable colors. For SVG, pass `includeColorTokens: true` to ALSO get `colorTokens` — the authoritative list of which color variable each paint is bound to ([{token, hex, property}] in document order) so the caller can inject its own {{token}} placeholders. (The plugin never mutates the SVG: matching hexes in SVG text is lossy — hard-coded colors collide with token colors — so token injection is left to the caller, which has the design-system context.)",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format (default PNG)"),
    scale: z.number().positive().optional().describe("Export scale (raster only, default 1)"),
    outputPath: z
      .string()
      .optional()
      .describe("If set, save the export to this file path (absolute, or relative to the server's working dir) instead of returning it inline. Parent directories are created automatically."),
    saveToGallery: z.boolean().optional().describe("Save into the relay/MCP managed export gallery so it can be browsed and cleaned from the web dashboard"),
    includeColorTokens: z
      .boolean()
      .optional()
      .describe("SVG only: also return `colorTokens` ([{token, hex, property}], document order) listing every paint bound to a color variable, so the caller can map resolved colors back to design tokens. The SVG itself keeps real colors."),
  },
  async ({ nodeId, format, scale, outputPath, saveToGallery, includeColorTokens }: any) => {
    try {
      if (options.remoteExportBase && outputPath) {
        throw new Error("outputPath is disabled in HTTP mode; omit it to receive a tunnel download URL");
      }
      const fmt = (format || "PNG").toUpperCase();
      const result = (await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: fmt,
        scale: scale || 1,
        includeColorTokens: !!includeColorTokens,
      })) as {
        imageBytes?: Buffer | Uint8Array;
        mimeType: string;
        nodeName?: string;
        svg?: string;
        colorTokens?: Array<{ token: string; hex: string; property: string }>;
        usedTokens?: string[];
        width?: number;
        height?: number;
      };

      // HTTP mode runs on a remote Mac. Returning its local filesystem path would be useless to
      // the caller, so persist into the dedicated export directory and return the tunnel URL.
      if (!outputPath && options.remoteExportBase) {
        const extension = fmt.toLowerCase();
        const name = `${uuidv4()}.${extension}`;
        const resolved = path.join(exportDirectory, name);
        fs.mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
        if (fmt === "SVG" && typeof result.svg === "string") {
          fs.writeFileSync(resolved, result.svg, { encoding: "utf8", mode: 0o600 });
        } else {
          if (!result.imageBytes) throw new Error("Figma export returned no image bytes");
          fs.writeFileSync(resolved, Buffer.from(result.imageBytes), { mode: 0o600 });
        }
        const stat = fs.statSync(resolved);
        const summary: any = {
          saved: true,
          url: `${options.remoteExportBase}/files/${name}`,
          expiresInHours: exportTTL / (60 * 60 * 1000),
          nodeName: result.nodeName,
          format: fmt,
          bytes: stat.size,
        };
        if (typeof result.width === "number") summary.width = result.width;
        if (typeof result.height === "number") summary.height = result.height;
        if (result.colorTokens) summary.colorTokens = result.colorTokens;
        if (result.usedTokens) summary.usedTokens = result.usedTokens;
        return { content: [{ type: "text", text: JSON.stringify(summary) }] };
      }

      // --- Save to disk when an output path is provided ---------------------
      if (saveToGallery && !outputPath) {
        const extension = fmt === "JPG" ? "jpg" : fmt.toLowerCase();
        const payload = fmt === "SVG" && typeof result.svg === "string" ? result.svg : result.imageBytes;
        if (!payload) throw new Error("Image payload was not received");
        const gallery = await saveToRelayGallery(payload, result.nodeName || "figma-export", extension);
        return { content: [{ type: "text", text: JSON.stringify({ ...gallery, managed: true, nodeName: result.nodeName, format: fmt }) }] };
      }

      if (outputPath) {
        const resolved = path.resolve(outputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        if (fmt === "SVG" && typeof result.svg === "string") {
          fs.writeFileSync(resolved, result.svg, "utf8");
        } else {
          if (!result.imageBytes) throw new Error("Image payload was not received");
          fs.writeFileSync(resolved, Buffer.from(result.imageBytes));
        }
        const stat = fs.statSync(resolved);
        const summary: any = {
          saved: true,
          path: resolved,
          nodeName: result.nodeName,
          format: fmt,
          bytes: stat.size,
        };
        if (typeof result.width === "number") summary.width = result.width;
        if (typeof result.height === "number") summary.height = result.height;
        if (result.colorTokens) summary.colorTokens = result.colorTokens;
        if (result.usedTokens) summary.usedTokens = result.usedTokens;
        return { content: [{ type: "text", text: JSON.stringify(summary) }] };
      }

      // --- SVG inline -------------------------------------------------------
      // With color tokens: return svg + the binding metadata as JSON.
      // Without: return the raw SVG text (directly usable / renderable).
      if (fmt === "SVG" && typeof result.svg === "string") {
        if (result.colorTokens) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                nodeName: result.nodeName,
                svg: result.svg,
                colorTokens: result.colorTokens,
                usedTokens: result.usedTokens,
              }),
            }],
          };
        }
        return { content: [{ type: "text", text: result.svg }] };
      }

      // --- Raster / PDF inline image ---------------------------------------
      if (!result.imageBytes) throw new Error("Image payload was not received");
      return {
        content: [
          {
            type: "image",
            // MCP image content still requires base64. Conversion happens only
            // here, after the binary has crossed plugin → relay → Bun.
            data: Buffer.from(result.imageBytes).toString("base64"),
            mimeType: result.mimeType || "image/png",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get_current_figma_screenshot",
  "Capture the matching local Figma application window on macOS. This requires Screen Recording permission and a visible local Figma window. If outputPath is provided, save the image on the MCP server machine instead of returning it inline.",
  {
    maxDimension: z.number().int().min(320).max(2400).optional().describe("Maximum output width or height in pixels (default 1200)"),
    outputPath: z.string().optional().describe("Optional path on the MCP server machine where the captured image should be saved"),
    saveToGallery: z.boolean().optional().describe("Save into the managed export gallery shown in the web dashboard"),
  },
  async ({ maxDimension, outputPath, saveToGallery }: any) => {
    try {
      const localCapture = await captureLocalFigmaWindow(selectedProject?.name, maxDimension || 1200);
      const result = {
        imageBytes: localCapture.bytes,
        mimeType: localCapture.mimeType,
        nodeName: localCapture.windowName,
        source: "app-window",
        width: localCapture.width,
        height: localCapture.height,
        capturedAt: localCapture.capturedAt,
      };
      if (!result.imageBytes) throw new Error("Image payload was not received");
      const metadata = {
        nodeName: result.nodeName,
        source: result.source,
        width: result.width,
        height: result.height,
        capturedAt: result.capturedAt,
      };
      if (saveToGallery && !outputPath) {
        const extension = result.mimeType === "image/jpeg" ? "jpg" : "png";
        const gallery = await saveToRelayGallery(result.imageBytes, result.nodeName || "figma-screenshot", extension);
        return { content: [{ type: "text", text: JSON.stringify({ ...gallery, managed: true, ...metadata }) }] };
      }
      if (outputPath) {
        const resolved = path.resolve(outputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, Buffer.from(result.imageBytes));
        return { content: [{ type: "text", text: JSON.stringify({ saved: true, path: resolved, bytes: fs.statSync(resolved).size, ...metadata }) }] };
      }
      return {
        content: [
          { type: "image", data: Buffer.from(result.imageBytes).toString("base64"), mimeType: result.mimeType || "image/png" },
          { type: "text", text: JSON.stringify(metadata) },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error capturing current Figma screenshot: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Text Content Tool
server.tool(
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    text: z.string().describe("New text content"),
  },
  async ({ nodeId, text }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Styles Tool
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
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get local components and component sets (id, name, type, key, remote). Supports pagination (`limit`/`offset`, with `total`/`nextOffset` in the response) and `countOnly` for large libraries.",
  {
    limit: z.number().int().positive().optional().describe("Max components to return; response includes total and nextOffset."),
    offset: z.number().int().min(0).optional().describe("Start index for pagination."),
    countOnly: z.boolean().optional().describe("Return only the total count."),
  },
  async ({ limit, offset, countOnly }: any) => {
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
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information")
  },
  async ({ nodeId, includeCategories }: any) => {
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

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z.array(z.object({
      type: z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
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

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z.array(z.object({
            type: z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      )
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma. For LOCAL components (from get_local_components), use componentId with the id field. For published LIBRARY components, use componentKey with the publishedKey field.",
  {
    componentId: z.string().optional().describe("ID of a local component (use the id field from get_local_components result). Use this for unpublished/local components."),
    componentKey: z.string().optional().describe("Key of a published library component to instantiate (use the publishedKey field from get_local_components result). Only works for published components."),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    parentId: z.string().optional().describe("Optional parent node ID to place the instance into"),
  },
  async ({ componentId, componentKey, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentId,
        componentKey,
        x,
        y,
        parentId,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Copy Instance Overrides Tool
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used."),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`
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

// Set Instance Overrides Tool
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z.array(z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result as setInstanceOverridesResult;

      if (typedResult.success) {
        const successCount = typedResult.results?.filter(r => r.success).length || 0;
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


// Set Corner Radius Tool
server.tool(
  "set_corner_radius",
  "Set the corner radius of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    radius: z.number().min(0).describe("Corner radius value"),
    corners: z
      .array(z.boolean())
      .length(4)
      .optional()
      .describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      ),
  },
  async ({ nodeId, radius, corners }: any) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true],
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Define design strategy prompt
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
    - Don't have account (text)`,
          },
        },
      ],
      description: "Best practices for working with Figma designs",
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
`,
          },
        },
      ],
      description: "Best practices for reading Figma designs",
    };
  }
);

// Text Node Scanning Tool
server.tool(
  "scan_text_nodes",
  "Scan all text nodes in the selected Figma node. Expensive on whole pages — if you are looking for a node by name, use search_nodes first and scan only the matched subtree.",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    chunkSize: z.number().int().positive().optional().describe("Nodes processed per chunk (default 50). Larger = fewer round-trips/progress updates."),
    highlight: z.boolean().optional().describe("Visually flash each text node while scanning. Default false — enabling it is much slower (adds a fill write + delay per node)."),
  },
  async ({ nodeId, chunkSize, highlight }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: "Starting text node scanning. This may take a moment for large designs...",
      };

      // Use the plugin's scan_text_nodes function with chunking flag
      const result = await sendCommandToFigma("scan_text_nodes", {
        nodeId,
        useChunking: true,            // Enable chunking on the plugin side
        chunkSize: chunkSize || 50,   // Process 50 nodes at a time by default
        skipHighlight: !highlight,    // Skip cosmetic per-node highlighting unless asked
      });

      // If the result indicates chunking was used, format the response accordingly
      if (result && typeof result === 'object' && 'chunks' in result) {
        const typedResult = result as {
          success: boolean,
          totalNodes: number,
          processedNodes: number,
          chunks: number,
          textNodes: Array<any>
        };

        const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.textNodes, null, 2)
            }
          ],
        };
      }

      // If chunking wasn't used or wasn't reported in the result format, return the result as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Type Scanning Tool
server.tool(
  "scan_nodes_by_types",
  "Scan for descendant nodes of specific types under a node. Supports pagination (`limit`/`offset` with `nextOffset` in the response) and `countOnly` for an unbounded section. INSTANCE results are enriched with `componentProperties` (variant state) and `mainComponent` (key/remote) so instance→variant mapping needs no second file — enrichment is capped at 300 instances per call (`enrichmentTruncated:true` in the response means you should page with `limit` to enrich the rest). Returns a single structured JSON object (status is in fields, not separate text blocks).",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z.array(z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME', 'INSTANCE'])"),
    limit: z.number().int().positive().optional().describe("Max nodes to return; the response includes total and nextOffset for paging."),
    offset: z.number().int().min(0).optional().describe("Start index for pagination (use the previous response's nextOffset)."),
    countOnly: z.boolean().optional().describe("Return only the total count, no node payload."),
  },
  async ({ nodeId, types, limit, offset, countOnly }: any) => {
    try {
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types,
        limit,
        offset,
        countOnly,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Text Replacement Strategy Prompt
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

Remember that text is never just text—it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`,
          },
        },
      ],
      description: "Systematic approach for replacing text in Figma designs",
    };
  }
);

// Set Multiple Text Contents Tool
server.tool(
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the text nodes to replace"),
    text: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          text: z.string().describe("The replacement text"),
        })
      )
      .describe("Array of text node IDs and their replacement texts"),
  },
  async ({ nodeId, text }: any) => {
    try {
      if (!text || text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = text.length;

      // Use the plugin's set_multiple_text_contents function with chunking
      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text,
      });

      // Cast the result to a specific type to work with it safely
      interface TextReplaceResult {
        success: boolean;
        nodeId: string;
        replacementsApplied?: number;
        replacementsFailed?: number;
        totalReplacements?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          originalText?: string;
          translatedText?: string;
        }>;
      }

      const typedResult = result as TextReplaceResult;

      // Format the results for display
      const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Annotation Conversion Strategy Prompt
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
          },
        },
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations",
    };
  }
);

// Instance Slot Filling Strategy Prompt
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
- Preserve component relationships by using instance overrides rather than direct text manipulation`,
          },
        },
      ],
      description: "Strategy for transferring overrides between component instances in Figma",
    };
  }
);

// Set Layout Mode Tool
server.tool(
  "set_layout_mode",
  "Set the layout mode and wrap behavior of a frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
  },
  async ({ nodeId, layoutMode, layoutWrap }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_mode", {
        nodeId,
        layoutMode,
        layoutWrap: layoutWrap || "NO_WRAP"
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ''}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Padding Tool
server.tool(
  "set_padding",
  "Set padding values for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    paddingTop: z.number().optional().describe("Top padding value"),
    paddingRight: z.number().optional().describe("Right padding value"),
    paddingBottom: z.number().optional().describe("Bottom padding value"),
    paddingLeft: z.number().optional().describe("Left padding value"),
  },
  async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }: any) => {
    try {
      const result = await sendCommandToFigma("set_padding", {
        nodeId,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
      });
      const typedResult = result as { name: string };

      // Create a message about which padding values were set
      const paddingMessages = [];
      if (paddingTop !== undefined) paddingMessages.push(`top: ${paddingTop}`);
      if (paddingRight !== undefined) paddingMessages.push(`right: ${paddingRight}`);
      if (paddingBottom !== undefined) paddingMessages.push(`bottom: ${paddingBottom}`);
      if (paddingLeft !== undefined) paddingMessages.push(`left: ${paddingLeft}`);

      const paddingText = paddingMessages.length > 0
        ? `padding (${paddingMessages.join(', ')})`
        : "padding";

      return {
        content: [
          {
            type: "text",
            text: `Set ${paddingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Axis Align Tool
server.tool(
  "set_axis_align",
  "Set primary and counter axis alignment for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "BASELINE"])
      .optional()
      .describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
  },
  async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }: any) => {
    try {
      const result = await sendCommandToFigma("set_axis_align", {
        nodeId,
        primaryAxisAlignItems,
        counterAxisAlignItems
      });
      const typedResult = result as { name: string };

      // Create a message about which alignments were set
      const alignMessages = [];
      if (primaryAxisAlignItems !== undefined) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
      if (counterAxisAlignItems !== undefined) alignMessages.push(`counter: ${counterAxisAlignItems}`);

      const alignText = alignMessages.length > 0
        ? `axis alignment (${alignMessages.join(', ')})`
        : "axis alignment";

      return {
        content: [
          {
            type: "text",
            text: `Set ${alignText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Layout Sizing Tool
server.tool(
  "set_layout_sizing",
  "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
  },
  async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_sizing", {
        nodeId,
        layoutSizingHorizontal,
        layoutSizingVertical
      });
      const typedResult = result as { name: string };

      // Create a message about which sizing modes were set
      const sizingMessages = [];
      if (layoutSizingHorizontal !== undefined) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
      if (layoutSizingVertical !== undefined) sizingMessages.push(`vertical: ${layoutSizingVertical}`);

      const sizingText = sizingMessages.length > 0
        ? `layout sizing (${sizingMessages.join(', ')})`
        : "layout sizing";

      return {
        content: [
          {
            type: "text",
            text: `Set ${sizingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Item Spacing Tool
server.tool(
  "set_item_spacing",
  "Set distance between children in an auto-layout frame",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    itemSpacing: z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    counterAxisSpacing: z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
  },
  async ({ nodeId, itemSpacing, counterAxisSpacing}: any) => {
    try {
      const params: any = { nodeId };
      if (itemSpacing !== undefined) params.itemSpacing = itemSpacing;
      if (counterAxisSpacing !== undefined) params.counterAxisSpacing = counterAxisSpacing;
      
      const result = await sendCommandToFigma("set_item_spacing", params);
      const typedResult = result as { name: string, itemSpacing?: number, counterAxisSpacing?: number };

      let message = `Updated spacing for frame "${typedResult.name}":`;
      if (itemSpacing !== undefined) message += ` itemSpacing=${itemSpacing}`;
      if (counterAxisSpacing !== undefined) message += ` counterAxisSpacing=${counterAxisSpacing}`;

      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// A tool to read Figma Motion (Animation panel) data — keyframes, tracks, timelines
server.tool(
  "get_motion",
  "Read Figma Motion animation data (Animation panel) for a node and its descendants: `animations` keyframes per animatable field, `manualKeyframeTracks`, `timelines`, and applied `animationStyles`, plus the document's timelines and available animation styles. This is NOT prototype data — Motion animations are invisible to `get_reactions`. Use this to get exact durations, keyframe positions and easing for looping/ambient animations.",
  {
    nodeId: z.string().describe("Node ID to read Motion data from (its subtree is included)"),
    maxDepth: z.number().int().min(0).optional().describe("How many levels below the node to include. Defaults to 6."),
  },
  async ({ nodeId, maxDepth }: any) => {
    try {
      const result = await sendCommandToFigma("get_motion", { nodeId, maxDepth });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading Motion data: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// A tool to get Figma Prototyping Reactions from multiple nodes
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. Searches each node and its descendants. For deeply nested nodes, pass `maxDepth` to cap how far the search recurses (an unbounded deep scan can time out). CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
    maxDepth: z.number().int().min(0).optional().describe("Max levels below each given node to search for reactions. 0 = the given node only, 1 = its direct children, etc. Omit to search the full subtree. Use this when a deep node makes the scan time out."),
  },
  async ({ nodeIds, maxDepth }: any) => {
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
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Connectors Tool
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }: any) => {
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

// Connect Nodes Tool
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z.array(z.object({
      startNodeId: z.string().describe("ID of the starting node"),
      endNodeId: z.string().describe("ID of the ending node"),
      text: z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }: any) => {
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

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Strategy for converting Figma prototype reactions to connector lines
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
     - If \`triggerType\` is "ON\_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON\_DRAG" and \`actionType\` is "OPEN\_OVERLAY": "On drag, open [Destination Node Name] overlay"
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
          },
        },
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    };
  }
);


// Define command types and parameters
type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_nodes_info"
  | "get_frame_context"
  | "read_my_design"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_image_fill_from_node"
  | "get_node_geometry"
  | "set_image_fill_from_bytes"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_components"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "get_current_figma_screenshot"
  | "join"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_layout_mode"
  | "set_padding"
  | "set_axis_align"
  | "set_layout_sizing"
  | "set_item_spacing"
  | "get_reactions"
  | "get_motion"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_node_names"
  | "copy_image_fill"
  | "create_section"
  | "set_node_data"
  | "get_node_data"
  | "delete_node_data"
  | "detach_instance"
  | "mirror_horizontal"
  | "set_text_align"
  | "get_text_segments"
  | "set_text_segments"
  | "create_component_from_node"
  | "set_selections"
  | "list_pages"
  | "set_current_page"
  | "get_node_by_key"
  | "diagnose_pages"
  | "get_design_system_info"
  | "get_nodes_design_info"
  | "scan_design_usage"
  | "search_nodes"
  | "get_file_outline"
  | "get_project_context"
  | "set_project_context"
  | "set_node_keywords"
  | "harvest_keyword_annotations"
  | "run_script";

type CommandParams = {
  get_document_info: Record<string, never>;
  get_selection: Record<string, never>;
  get_node_info: { nodeId: string };
  get_nodes_info: { nodeIds: string[] };
  get_frame_context: {
    nodeId: string;
    excludeChrome?: boolean;
    chromeNames?: string[];
    includeHash?: boolean;
    maxDepth?: number;
  };
  create_rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
  };
  create_frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
  };
  create_text: {
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontWeight?: number;
    fontColor?: { r: number; g: number; b: number; a?: number };
    name?: string;
    parentId?: string;
  };
  set_fill_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
  };
  set_stroke_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
    weight?: number;
  };
  move_node: {
    nodeId: string;
    x: number;
    y: number;
  };
  resize_node: {
    nodeId: string;
    width: number;
    height: number;
  };
  delete_node: {
    nodeId: string;
  };
  delete_multiple_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  create_component_instance: {
    componentKey: string;
    x: number;
    y: number;
  };
  get_instance_overrides: {
    instanceNodeId: string | null;
  };
  set_instance_overrides: {
    targetNodeIds: string[];
    sourceInstanceId: string;
  };
  export_node_as_image: {
    nodeId: string;
    format?: "PNG" | "JPG" | "SVG" | "PDF";
    scale?: number;
  };
  get_current_figma_screenshot: {
    maxDimension?: number;
  };
  execute_code: {
    code: string;
  };
  join: {
    channel: string;
  };
  set_corner_radius: {
    nodeId: string;
    radius: number;
    corners?: boolean[];
  };
  clone_node: {
    nodeId: string;
    x?: number;
    y?: number;
  };
  set_text_content: {
    nodeId: string;
    text: string;
  };
  scan_text_nodes: {
    nodeId: string;
    useChunking: boolean;
    chunkSize: number;
  };
  set_multiple_text_contents: {
    nodeId: string;
    text: Array<{ nodeId: string; text: string }>;
  };
  get_annotations: {
    nodeId?: string;
    includeCategories?: boolean;
  };
  set_annotation: {
    nodeId: string;
    annotationId?: string;
    labelMarkdown: string;
    categoryId?: string;
    properties?: Array<{ type: string }>;
  };
  set_multiple_annotations: SetMultipleAnnotationsParams;
  scan_nodes_by_types: {
    nodeId: string;
    types: Array<string>;
  };
  get_reactions: { nodeIds: string[]; maxDepth?: number };
  get_motion: { nodeId: string; maxDepth?: number };
  set_default_connector: {
    connectorId?: string | undefined;
  };
  create_connections: {
    connections: Array<{
      startNodeId: string;
      endNodeId: string;
      text?: string;
    }>;
  };
  set_focus: {
    nodeId: string;
  };
  set_selections: {
    nodeIds: string[];
  };

};


// Helper function to process Figma node responses
function processFigmaNodeResponse(result: unknown): any {
  if (!result || typeof result !== "object") {
    return result;
  }

  // Check if this looks like a node response
  const resultObj = result as Record<string, unknown>;
  if ("id" in resultObj && typeof resultObj.id === "string") {
    // It appears to be a node response, log the details
    console.info(
      `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id
      })`
    );

    if ("x" in resultObj && "y" in resultObj) {
      console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
    }

    if ("width" in resultObj && "height" in resultObj) {
      console.debug(`Node dimensions: ${resultObj.width}×${resultObj.height}`);
    }
  }

  return result;
}

// Update the connectToFigma function
function connectToFigma(port: number = 3055) {
  if (disposed) return;
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  const wsUrl = serverUrl === 'localhost' ? `ws://localhost:${port}` : RELAY_WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    logger.info('Connected to Figma socket server');
    currentChannel = null;
    fatalProtocolError = null;
    ws?.send(JSON.stringify({
      type: "hello",
      role: "controller",
      requesterId,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: process.env.TALK_TO_FIGMA_DEVICE_NAME || os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      capabilities: ["binaryFrames", "livePreview"],
    }));
    if (desiredChannel) {
      joinChannel(desiredChannel).catch((error) =>
        logger.warn(`Could not resume project connection: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  });

  ws.on("message", (data: any, isBinary: boolean) => {
    try {
      // Define a more specific type with an index signature to allow any property access
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any; // Allow any other properties
      }

      let binaryPayload: Buffer | undefined;
      let json: ProgressMessage;
      if (isBinary) {
        const decoded = decodeBinaryFrame(data);
        json = decoded.envelope as ProgressMessage;
        binaryPayload = decoded.payload;
      } else {
        json = JSON.parse(rawDataToBuffer(data).toString("utf8")) as ProgressMessage;
      }

      if (json.type === "system" && (json as any).event === "protocol_mismatch") {
        fatalProtocolError = String((json as any).message || `Protocol mismatch. MCP=${PROTOCOL_VERSION}`);
        currentChannel = null;
        desiredChannel = null;
        pendingRequests.forEach((request, id) => {
          clearTimeout(request.timeout);
          request.reject(new Error(fatalProtocolError!));
          pendingRequests.delete(id);
        });
        logger.error(fatalProtocolError);
        return;
      }

      // Handle progress updates
      if (json.type === 'progress_update') {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.id || '';

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;

          // Update last activity timestamp
          request.lastActivity = Date.now();

          // Reset the timeout to prevent timeouts during long-running operations
          clearTimeout(request.timeout);

          // Create a new timeout
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended period of inactivity`);
              pendingRequests.delete(requestId);
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "request_timeout", id: requestId, channel: request.channel, requesterId }));
              }
              request.reject(new Error('Request to Figma timed out'));
            }
          }, 60000); // 60 second timeout for inactivity

          // Log progress
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

          // For completed updates, we could resolve the request early if desired
          if (progressData.status === 'completed' && progressData.progress === 100) {
            // Optionally resolve early with partial data
            // request.resolve(progressData.payload);
            // pendingRequests.delete(requestId);

            // Instead, just log the completion, wait for final result from Figma
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }

      // The relay closed our channel because the Figma plugin left. We're no
      // longer in a channel — reset state and fail in-flight requests fast with
      // an actionable message instead of letting them time out.
      if (json.type === 'system' && (json as any).event === 'channel_closed') {
        logger.warn(`Channel "${json.channel}" closed: the Figma plugin left. You must join a channel again.`);
        currentChannel = null;
        const reason = new Error(
          'Channel closed: the Figma plugin disconnected. Use list_figma_channels to find the current channel, then join_channel again.'
        );
        pendingRequests.forEach((request, id) => {
          clearTimeout(request.timeout);
          request.reject(reason);
          pendingRequests.delete(id);
        });
        return;
      }

      // Handle regular responses
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log('myResponse' + JSON.stringify(myResponse));

      // Handle response to a request
      if (
        myResponse?.id &&
        pendingRequests.has(myResponse.id) &&
        (myResponse.result !== undefined || myResponse.error !== undefined)
      ) {
        const request = pendingRequests.get(myResponse.id)!;
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
        // Handle broadcast messages or events
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on('error', (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on('close', () => {
    logger.info('Disconnected from Figma socket server');
    ws = null;

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    if (!disposed) {
      if (fatalProtocolError) {
        logger.error(`Reconnect paused: ${fatalProtocolError}`);
      } else {
        logger.info('Attempting to reconnect in 2 seconds...');
        reconnectTimer = setTimeout(() => connectToFigma(port), 2000);
      }
    }
  });
}

// Function to join a channel
async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
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

// Function to send commands to Figma
async function relayProjectsPayload(): Promise<any> {
  const httpUrl = relayHttpUrl("projects");
  const response = await fetch(httpUrl);
  if (!response.ok) throw new Error(`relay returned HTTP ${response.status}`);
  return (await response.json()) as any;
}

async function relayProjects(): Promise<any[]> {
  return (await relayProjectsPayload()).projects || [];
}

async function selectProject(query?: string): Promise<any> {
  const projects = await relayProjects();
  const live = projects.filter((project: any) => project.connectionCount > 0 && project.recommendedChannel);
  if (!live.length) throw new Error("No live Figma projects are connected");
  let matches = live;
  if (query) {
    const normalized = query.toLowerCase();
    matches = live.filter((project: any) =>
      [project.name, project.fileKey, project.projectKey].some((value) => String(value || "").toLowerCase().includes(normalized))
    );
  }
  if (matches.length !== 1) {
    throw new Error(query
      ? `Project query matched ${matches.length} projects: ${matches.map((project: any) => project.name).join(", ") || "none"}`
      : `Choose a project first — call use_figma_project with one of: ${live.map((project: any) => project.name).join(", ")}`);
  }
  const project = matches[0];
  await joinChannel(project.recommendedChannel);
  selectedProject = { projectKey: project.projectKey, name: project.name, fileKey: project.fileKey };
  persistSelectedProject(selectedProject);
  return project;
}

function currentProjectKey(): string {
  return selectedProject?.projectKey || selectedProject?.fileKey || selectedProject?.name || "";
}

// Read the project context document from the LIVE Figma document (the source
// of truth: figma.root sharedPluginData) and mirror it into the local disk
// cache so the console and search_nodes can see it without a plugin
// round-trip. Root data needs no page loads, so this is a few ms.
async function fetchProjectContextFromDocument(timeoutMs = 15000): Promise<any> {
  const result = (await sendCommandToFigma("get_project_context", {}, timeoutMs)) as any;
  const projectKey = currentProjectKey();
  if (projectKey) {
    if (result?.exists && typeof result.content === "string") {
      cacheProjectContext(projectKey, {
        content: result.content,
        updatedAt: result.updatedAt ?? null,
        updatedBy: result.updatedBy ?? null,
      });
    } else {
      clearCachedProjectContext(projectKey);
    }
  }
  return result;
}

// When a project has no context document yet, hand the calling agent raw
// material (an outline summary from the relay's disk index) to DRAFT one from.
function buildContextDraftMaterial(projectKey: string): any | null {
  const index = loadProjectIndex(projectKey);
  if (!index || !index.pages.length) return null;
  const pages = index.pages.map((page) => {
    const name = page.pageName || "";
    const flags: string[] = [];
    if (/\[ab\]|\bab ?test|실험|experiment/i.test(name)) flags.push("experiment?");
    if (/^[\s\-=—–─═*·.·|/\\]+$/.test(name)) flags.push("divider");
    if (/개인|personal|playground|scratch|sandbox|draft|드래프트/i.test(name)) flags.push("personal?");
    if (/레퍼런스|reference|벤치마크|benchmark|모음|캡처|capture|스크린샷|screenshot/i.test(name)) flags.push("reference?");
    if (/아카이브|archive|백업|backup|\bold\b|deprecated|미사용|legacy/i.test(name)) flags.push("archive?");
    return {
      name,
      nodeCount: page.entries.length,
      ...(flags.length ? { flags } : {}),
    };
  });
  return { source: "disk-index", indexedAt: index.builtAt ?? index.updatedAt, pages };
}

async function ensureProjectSelected(): Promise<void> {
  if (currentChannel) return;
  if (selectedProject) {
    try {
      await selectProject(selectedProject.fileKey || selectedProject.projectKey || selectedProject.name);
      return;
    } catch (error) {
      // The previously selected (possibly persisted) project is no longer
      // live — fall through and auto-select if exactly one live project exists.
      logger.warn(`Previously selected project "${selectedProject.name}" is not available: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await selectProject();
}

async function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000
): Promise<unknown> {
  if (command !== "join") await ensureProjectSelected();
  return new Promise((resolve, reject) => {
    if (fatalProtocolError) {
      reject(new Error(fatalProtocolError));
      return;
    }
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      requesterId,
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "request_timeout", id, channel: currentChannel, requesterId }));
        }
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`);
        reject(new Error('Request to Figma timed out'));
      }
    }, timeoutMs);

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now(),
      command,
      channel: currentChannel,
    });

    // Send the request
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

heartbeatTimer = setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "heartbeat",
      role: "controller",
      requesterId,
      protocolVersion: PROTOCOL_VERSION,
      channel: currentChannel,
      ts: Date.now(),
    }));
  }
}, 10_000);

// ===========================================================================
// Page navigation & key resolution
// ===========================================================================

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
  "Search the WHOLE FILE (every page) in a single call for nodes matching the query (case-insensitive) — by node NAME and/or by on-screen TEXT content (a TEXT node's characters, i.e. the UI copy). So you can find a screen both by its layer name and by the wording visible in it, even when layers are named differently from the feature. Do NOT walk pages one by one with get_document_info or scan whole pages with scan_text_nodes to find something — use this tool first, then drill into the returned node/page ids. IMPORTANT: pass EVERY plausible spelling of the concept you are looking for in `queries` at once — Korean/English, joined/spaced, product name vs feature name (e.g. ['짐챗','GymChat','Gym Chat']); they are OR-matched in one pass. Matching also ignores whitespace ('gym chat' matches a 'GymChat' layer). When the relay's background indexer has built a disk index for the project, the search answers from it instantly (response carries source: 'index' and indexedAt); pass fresh: true to force a live search if the index may be stale. Without an index, pages are searched live and sequentially (current page first, then file order), stopping as soon as `limit` matches are found — the FIRST such search must load and index each page, which can take tens of seconds on large files; later searches hit a per-page cache in the plugin and return in well under a second. Each match includes {id, name, type, pageId, pageName, path, matchedBy, matchedQuery} (text matches also carry a matchedText snippet); name matches sort before text matches. Keyword annotations registered via add_search_annotation are returned first with matchedBy: 'annotation' (not counted against `limit`). Optionally filter by node types or restrict to one page.",
  {
    query: z.string().optional().describe("Substring to match (case-insensitive, whitespace-insensitive) against node names and/or TEXT content. Provide this and/or `queries`."),
    queries: z.array(z.string()).optional().describe("Multiple spellings/variants of the concept, OR-matched in one pass (e.g. ['짐챗','GymChat','Gym Chat']). Provide this and/or `query`; both are merged."),
    match: z.enum(["name", "text", "both"]).optional().describe("What to match: 'name' = node names only, 'text' = TEXT node characters (UI copy) only, 'both' = either (default)."),
    types: z.array(z.string()).optional().describe("Optional node types to restrict NAME matching to, e.g. ['FRAME','COMPONENT','SECTION','TEXT']. Text matching always targets TEXT nodes."),
    pageId: z.string().optional().describe("Restrict the search to this page only (from list_pages/get_file_outline)."),
    limit: z.number().int().positive().optional().describe("Max matches to return (default 50, max 200)."),
    fresh: z.boolean().optional().describe("Skip the relay-built disk index and search the live file page by page. RARELY needed: the index is refreshed incrementally within minutes of edits, so prefer the default (index) path — a live full-file scan takes 30s+ and returns a partial result if it exceeds its 60s budget. Use only when you have concrete evidence the index is missing something changed seconds ago, or combine with pageId to keep it cheap."),
  },
  async ({ query, queries, match, types, pageId, limit, fresh }: any) => {
    try {
      // The plugin-side command searches ONE page per call; the file-wide loop
      // lives here. That keeps every single command well under its timeout
      // (cold page load measured at <=11s, so 30s/page is ample) and lets the
      // relay interleave other clients' commands between pages instead of the
      // plugin channel being monopolized for the whole file walk.
      const PER_PAGE_TIMEOUT_MS = 30000;
      const mode = match === "name" || match === "text" ? match : "both";
      const max = Math.max(1, Math.min(Number(limit) || 50, 200));
      const allQueries: string[] = [
        ...(typeof query === "string" ? [query] : []),
        ...(Array.isArray(queries) ? queries.filter((q: any) => typeof q === "string") : []),
      ].filter((q) => q.trim().length > 0);
      if (!allQueries.length) {
        return { content: [{ type: "text", text: "Error searching nodes: provide `query` and/or `queries`" }] };
      }

      // Learned keyword annotations for this project go on top of the results
      // (matchedBy: "annotation"), independent of `limit`. Ensure a project is
      // selected first so the lookup is scoped correctly.
      await ensureProjectSelected();
      const projectKey = selectedProject?.projectKey || selectedProject?.fileKey || selectedProject?.name || "";
      // If this project has a context document (cache-mirrored on every live
      // read, e.g. on use_figma_project), tell the caller to consult it before
      // interpreting matches — e.g. a hit on a reference page of competitor
      // captures is NOT our design.
      const contextFlag = hasCachedProjectContext(projectKey)
        ? { hasContext: true, contextNote: "이 프로젝트에는 컨텍스트 문서가 있다 — 결과 해석 전(어느 페이지의 무엇인지 판단하기 전) get_project_context 를 확인하라." }
        : {};
      const annotationMatches = findAnnotationsForKeys(
        projectKey,
        allQueries.map(normalizeKeywordKey)
      ).map((a: SearchAnnotation) => ({
        id: a.nodeId,
        name: a.nodeName,
        matchedBy: "annotation",
        matchedQuery: a.keyword,
        ...(a.note ? { note: a.note } : {}),
        addedAt: a.addedAt,
      }));

      // Index-first: if the relay's incremental indexer has persisted a disk
      // index for this project (shared path on the same machine), answer from
      // it in-process — no plugin round-trips at all. `fresh: true` or a
      // pageId restriction falls back to the live page loop.
      if (!fresh && !pageId) {
        const projectIndex = loadProjectIndex(projectKey);
        if (projectIndex && projectIndex.pages.length > 0) {
          const needles = buildNeedles(allQueries);
          const typeSet = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
          const matches: any[] = [];
          let totalMatches = 0;
          let truncated = false;
          for (const page of projectIndex.pages) {
            const nameFound: any[] = [];
            const textFound: any[] = [];
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
            totalMatches += nameFound.length + textFound.length;
            for (const found of nameFound) {
              if (matches.length >= max) { truncated = true; break; }
              matches.push({
                id: found.entry.id,
                name: found.entry.name,
                type: found.entry.type,
                pageId: page.pageId,
                pageName: page.pageName,
                path: found.entry.path,
                matchedBy: "name",
                matchedQuery: found.matchedQuery,
              });
            }
            if (!truncated) {
              for (const found of textFound) {
                if (matches.length >= max) { truncated = true; break; }
                matches.push({
                  id: found.entry.id,
                  name: found.entry.name,
                  type: found.entry.type,
                  pageId: page.pageId,
                  pageName: page.pageName,
                  path: found.entry.path,
                  matchedBy: "text",
                  matchedQuery: found.matchedQuery,
                  matchedText: textMatchSnippet(found.entry.characters as string, found.range),
                });
              }
            }
          }
          const result: any = {
            ...contextFlag,
            queries: allQueries,
            match: mode,
            source: "index",
            indexedAt: projectIndex.builtAt ?? projectIndex.updatedAt,
            totalMatches,
            truncated,
            totalScannedPages: projectIndex.pages.length,
            totalPages: projectIndex.pages.length,
            matches: [...annotationMatches, ...matches],
          };
          if (truncated) {
            result.note = `Only the first ${max} matches are returned (totalMatches counts all index hits). The result came from the disk index built at ${new Date(result.indexedAt).toISOString()}; pass fresh: true to search the live file instead.`;
          }
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
      }

      let pageOrder: Array<{ id: string; name: string }>;
      if (pageId) {
        pageOrder = [{ id: pageId, name: "" }];
      } else {
        // Lightweight page listing: ids/names only, no loadAllPagesAsync.
        const pageList = (await sendCommandToFigma(
          "list_pages",
          { withChildCounts: false },
          PER_PAGE_TIMEOUT_MS
        )) as any;
        const pages: Array<{ id: string; name: string }> = pageList?.pages || [];
        const currentId = pageList?.currentPageId;
        // Current page first (most likely target, already loaded), then file order.
        pageOrder = [
          ...pages.filter((p) => p.id === currentId),
          ...pages.filter((p) => p.id !== currentId),
        ];
      }

      const matches: any[] = [];
      const unreadablePages: Array<{ id: string; name: string; error?: string }> = [];
      let totalMatches = 0;
      let totalScannedPages = 0;
      let truncated = false;
      // Live-scan time budget: MCP callers sit behind their own request timeout
      // (nexus tunnel: 120s), so return a partial result before that ceiling
      // instead of letting the whole call die with nothing (session #7685).
      const LIVE_BUDGET_MS = 60_000;
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
          const pageResult = (await sendCommandToFigma(
            "search_nodes",
            { queries: allQueries, match: mode, types, pageId: page.id, limit: remaining },
            PER_PAGE_TIMEOUT_MS
          )) as any;
          totalMatches += pageResult?.totalMatches || 0;
          if (Array.isArray(pageResult?.matches)) matches.push(...pageResult.matches);
          if (pageResult?.truncated) truncated = true;
        } catch (error) {
          // A page containing an unclassifiable node type (see diagnose_pages)
          // or a per-page timeout should not fail the whole search.
          unreadablePages.push({
            id: page.id,
            name: page.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const result: any = {
        ...contextFlag,
        queries: allQueries,
        match: mode,
        source: "live",
        totalMatches,
        truncated,
        totalScannedPages,
        totalPages: pageOrder.length,
        matches: [...annotationMatches, ...matches],
      };
      if (truncated) {
        // totalMatches only covers scanned pages when we stopped early.
        result.note = `Stopped after ${totalScannedPages}/${pageOrder.length} pages once the limit of ${max} matches was reached; totalMatches counts scanned pages only.`;
      }
      if (budgetExhausted) {
        result.incomplete = true;
        result.note = `Time budget (${LIVE_BUDGET_MS / 1000}s) exhausted after ${totalScannedPages}/${pageOrder.length} pages — this is a PARTIAL result. Re-run without fresh (the disk index covers the whole file), or narrow with pageId.`;
      }
      if (unreadablePages.length) result.unreadablePages = unreadablePages;
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error searching nodes: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Keywords stored ON a node (SoR): sharedPluginData("talk_to_figma",
// "search_keywords") holds a JSON array [{keyword, note?, addedAt}].
function parseNodeKeywordValue(raw: unknown): Array<{ keyword: string; note?: string; addedAt?: string }> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k: any) => k && typeof k.keyword === "string" && k.keyword.trim());
  } catch {
    return [];
  }
}

async function readNodeKeywords(nodeId: string): Promise<Array<{ keyword: string; note?: string; addedAt?: string }>> {
  const data = (await sendCommandToFigma("get_node_data", {
    nodeId,
    namespace: "talk_to_figma",
    key: "search_keywords",
  })) as any;
  return parseNodeKeywordValue(data?.value);
}

server.tool(
  "add_search_annotation",
  "Register a learned keyword→node link so future search_nodes calls surface it on top (matchedBy: 'annotation'). Use this when a search did NOT find the right node but you identified it through another route (a task description, a Slack link, an operator's answer): register the keyword the search failed on, pointing at the confirmed node. The link is stored ON THE NODE ITSELF inside the Figma document (sharedPluginData), so it follows the file across machines and is deleted with the node; the local disk copy is only a search cache. Requires a live plugin connection. The keyword is normalized (lowercase, whitespace removed) for lookup; the original spelling is preserved. Same keyword+node updates in place.",
  {
    keyword: z.string().describe("The search keyword this node should be found under (the term the search failed on). Original spelling is kept; matching is case- and whitespace-insensitive."),
    nodeId: z.string().describe("The confirmed node id the keyword should resolve to."),
    note: z.string().optional().describe("Optional context for future readers (why this node, source of the confirmation)."),
  },
  async ({ keyword, nodeId, note }: any) => {
    try {
      if (!keyword || !keyword.trim()) throw new Error("keyword must be non-empty");
      const trimmed = keyword.trim();
      const keywordKey = normalizeKeywordKey(trimmed);
      // Read-modify-write the node's keyword list (SoR), then mirror to cache.
      const current = await readNodeKeywords(nodeId);
      const kept = current.filter((k) => normalizeKeywordKey(k.keyword) !== keywordKey);
      kept.push({ keyword: trimmed, ...(note ? { note } : {}), addedAt: new Date().toISOString() });
      const saved = (await sendCommandToFigma("set_node_keywords", { nodeId, keywords: kept })) as any;
      const projectKey = currentProjectKey();
      const annotation = upsertSearchAnnotation({
        keyword: trimmed,
        projectKey,
        nodeId,
        nodeName: String(saved?.nodeName ?? ""),
        note,
      });
      return { content: [{ type: "text", text: JSON.stringify({ saved: true, storedOnNode: true, annotation }) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error adding search annotation: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "remove_search_annotation",
  "Remove learned keyword→node annotation(s) for the CURRENT project. Use this when the operator (or any feedback) says an annotated answer was WRONG — remove it so searches stop surfacing it. Removes the keyword from the node's own sharedPluginData (the source of truth, requires a live plugin connection) and from the local search cache. Omit nodeId to remove every annotation stored under the keyword.",
  {
    keyword: z.string().describe("The keyword whose annotation(s) to remove (case- and whitespace-insensitive)."),
    nodeId: z.string().optional().describe("Remove only the annotation pointing at this node; omit to remove ALL annotations for the keyword."),
  },
  async ({ keyword, nodeId }: any) => {
    try {
      if (!keyword || !keyword.trim()) throw new Error("keyword must be non-empty");
      await ensureProjectSelected();
      const projectKey = currentProjectKey();
      const keywordKey = normalizeKeywordKey(keyword.trim());
      // Which nodes carry this keyword? The cache knows (it is rebuilt from
      // document harvests); an explicit nodeId wins.
      const targetNodeIds = nodeId
        ? [nodeId]
        : [...new Set(findAnnotationsForKeys(projectKey, [keywordKey]).map((a) => a.nodeId))];
      const nodeResults: Array<{ nodeId: string; removed: boolean; error?: string }> = [];
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
          // A deleted node no longer carries the annotation anyway — allow the
          // cache entry to be removed below.
          if (/not found/i.test(message)) nodeResults.push({ nodeId: target, removed: false });
          else nodeResults.push({ nodeId: target, removed: false, error: message });
        }
      }
      if (nodeResults.some((r) => r.error)) {
        // Do not silently drop the cache entry while the SoR still has it.
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
  "인덱서·커맨드·스크립트 에러 원장 — 반복되는 에러는 개선 대상으로 보고하라. Reads the shared on-disk error ledger (~/.talk-to-figma/errors.json) the relay maintains: indexer step failures and partial pages (skipped unknown-typed nodes), relayed plugin command errors/timeouts, /script/run failures, and relay-internal exceptions. Entries are newest-first; consecutive identical errors are collapsed with a `count`. An entry with a high count (or the same message recurring across days) is a signal the tooling itself should be fixed, not worked around.",
  {
    limit: z.number().optional().describe("Max entries to return (default 100, cap 500)."),
    source: z.enum(["indexer", "command", "script", "relay"]).optional().describe("Only errors from this source."),
  },
  async ({ limit, source }: any) => {
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
  "Run arbitrary JavaScript inside the Figma plugin sandbox with FULL access to the figma plugin API — use this to fill gaps where no dedicated tool exists. The code body may use await and must `return` the value you want back; the return value is serialized (JSON.stringify, falling back to String(), capped at 100KB) and returned in this tool's response, with thrown errors returned as message+stack. WARNING: this can MODIFY THE DOCUMENT directly — verify your target nodes before destructive changes (nothing is auto-committed; undo relies on Figma's own undo/version history). A synchronous infinite loop FREEZES the plugin with no way to abort remotely (the operator must re-run the plugin in Figma). If a dedicated tool already does the job, use the dedicated tool instead. Timeout 120s.",
  {
    code: z.string().describe("JavaScript function body. Receives (figma, params); may use await; `return` the result you want. E.g. \"const n = await figma.getNodeByIdAsync(params.id); return { name: n.name, w: n.width };\""),
    params: z.record(z.unknown()).optional().describe("Optional JSON object passed to the script as `params`."),
  },
  async ({ code, params }: any) => {
    try {
      const result = (await sendCommandToFigma("run_script", { code, params }, 120000)) as any;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error running Figma script: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "get_project_context",
  "Read the project's CONTEXT DOCUMENT — the Figma-side analogue of a code repo's CLAUDE.md, stored IN the Figma document itself (root sharedPluginData, so it follows the file across machines). It explains what the file structure MEANS: page purposes (e.g. a reference page holding competitor captures vs. actual in-progress designs), naming conventions, where each feature lives, and common misidentification traps. READ IT BEFORE interpreting search results or picking a screen as 'the' design. If the project has no context yet, the response includes outline material summarized from the search index — use it to DRAFT a structure guide and save it with set_project_context.",
  {
    project: z.string().optional().describe("Project/document name or file key. Omit for the currently selected project. Passing a different project SWITCHES the current selection (same as use_figma_project)."),
  },
  async ({ project }: any) => {
    try {
      if (project) await selectProject(project);
      const doc = await fetchProjectContextFromDocument();
      if (doc?.exists) {
        return { content: [{ type: "text", text: JSON.stringify({
          project: selectedProject?.name ?? null,
          fileName: doc.fileName ?? null,
          updatedAt: doc.updatedAt ?? null,
          updatedBy: doc.updatedBy ?? null,
          content: doc.content,
        }, null, 2) }] };
      }
      const material = buildContextDraftMaterial(currentProjectKey());
      return { content: [{ type: "text", text: JSON.stringify({
        exists: false,
        project: selectedProject?.name ?? null,
        note: "이 프로젝트에는 컨텍스트 문서가 아직 없다. 파일 구조를 파악했다면 — 페이지 용도, 명명 규칙, 기능별 위치, 흔한 오인 지점 — set_project_context 로 기록하라.",
        ...(material ? {
          draftMaterial: material,
          draftHint: "draftMaterial 은 디스크 인덱스에서 뽑은 페이지 아웃라인 요약이다(flags 는 이름 기반 휴리스틱 추정). 이를 재료로 구조 가이드 초안을 작성해 set_project_context 로 저장하라 — 단정하지 말고 실제 페이지 내용을 확인해 서술할 것.",
        } : {}),
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting project context: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "set_project_context",
  "Replace the project's CONTEXT DOCUMENT (full-document semantics; there is no partial patch — read with get_project_context, edit, then write the whole markdown back). Stored in the Figma document itself, so it syncs everywhere the file is opened. Record: page purposes (e.g. '레퍼런스 페이지 = 타사 캡처 모음, 우리 디자인 아님' vs '작업 중 = 진행 디자인'), naming conventions, where each feature's screens live, and common misidentification traps. When the operator gives feedback that something was found WRONG (잘못 찾았다), update this document with that lesson so the next agent does not repeat the mistake. Max 50KB UTF-8. An empty string clears the document.",
  {
    content: z.string().describe("The full markdown context document (replaces the previous one; the previous document is what get_project_context returned). Empty string clears it."),
    project: z.string().optional().describe("Project/document name or file key. Omit for the currently selected project. Passing a different project SWITCHES the current selection (same as use_figma_project)."),
  },
  async ({ content, project }: any) => {
    try {
      if (project) await selectProject(project);
      const result = (await sendCommandToFigma("set_project_context", { content }, 15000)) as any;
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
      const result = await sendCommandToFigma("get_file_outline", {}, 120000);
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
    pageId: z.string().describe("The page id to switch to (from list_pages)."),
  },
  async ({ pageId }: any) => {
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
  "Scan every page and report which pages have a node this plugin API can't classify (the cause of 'Unknown node type … getPublicNodeType' errors). For each unreadable page it returns the container(s) whose children couldn't be read, and best-effort tries a REST export of those containers to surface the offending child node's id/name/type. Use this to find what node is breaking reads.",
  {
    tryExport: z.boolean().optional().describe("Try a REST export of each skipped container to identify the offending child type (default true)."),
    deep: z.boolean().optional().describe("Also recurse below readable containers to find deeply-nested unclassifiable nodes (slower; default false checks only each page's direct children)."),
  },
  async ({ tryExport, deep }: any) => {
    try {
      const result = await sendCommandToFigma("diagnose_pages", { tryExport: tryExport !== false, deep: !!deep }, 120000);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error diagnosing pages: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "get_node_by_key",
  "Resolve a design-system `key` (component, component set, or style key from get_design_system_info / get_local_components) to a live node id, so you can go straight from a catalog key to get_node_info or export. Tries local components first; for a published key not found locally it falls back to importing the asset into the file (importComponentByKeyAsync/importStyleByKeyAsync) — a read with a small side effect (the library asset becomes referenced in this file). Returns { found, id, type, remote, source, ... }.",
  {
    key: z.string().describe("The component/style key to resolve."),
  },
  async ({ key }: any) => {
    try {
      const result = await sendCommandToFigma("get_node_by_key", { key });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error resolving key: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// ===========================================================================
// Design-system usage analysis tools
// ===========================================================================

// Foundation catalog: components + styles + VARIABLES (each with a `key`).
server.tool(
  "get_design_system_info",
  "Get the full design-system catalog of the current file: components & component sets, paint/text/effect/grid styles, and Variables (with collections, modes, and per-mode values). Every item includes its `key` — the identifier shared with consuming files for a published library asset. Run this on the Foundation/library file to build the catalog you match Product references against. Unlike get_styles, this includes Variables (color tokens).",
  {
    includeVariableValues: z.boolean().optional().describe("Include each variable's resolved value per mode (default true)."),
    resolveNames: z.boolean().optional().describe("Include human-readable names (default true)."),
  },
  async ({ includeVariableValues, resolveNames }: any) => {
    try {
      const result = await sendCommandToFigma("get_design_system_info", {
        includeVariableValues: includeVariableValues !== false,
        resolveNames: resolveNames !== false,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting design system info: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Per-node design-system bindings for an explicit set of node IDs.
server.tool(
  "get_nodes_design_info",
  "For specific node IDs, return what each node references in the design system: for INSTANCEs the main component (key, remote flag, component-set key), any fill/stroke/text/effect/grid STYLE references (key, remote), and any bound VARIABLES per property (key, resolvedType). Use the keys to match against get_design_system_info from the Foundation file. Missing/raw values are omitted (a node with no `component`/`styles`/`boundVariables` uses no tokens there).",
  {
    nodeIds: z.array(z.string()).describe("Node IDs to inspect"),
    resolveNames: z.boolean().optional().describe("Include human-readable names (default true)."),
  },
  async ({ nodeIds, resolveNames }: any) => {
    try {
      const result = await sendCommandToFigma("get_nodes_design_info", {
        nodeIds,
        resolveNames: resolveNames !== false,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting node design info: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Bulk subtree scan -> aggregated design-system usage summary.
server.tool(
  "scan_design_usage",
  "Scan a node subtree (chunked) and return an AGGREGATED design-system usage summary: instances grouped by main-component key (with remote/local/detached counts), style references grouped by style key per slot, variable bindings grouped by variable key, and a fill token-coverage signal (tokenizedOrStyled vs rawSolid). Built for large trees (~1000s of nodes) — returns counts + sample node IDs per key, not every node, unless includeNodes is set. Match the keys against get_design_system_info from the Foundation file to compute reuse rates.",
  {
    nodeId: z.string().describe("Root node ID of the subtree to scan (e.g. a page or top frame)"),
    chunkSize: z.number().int().positive().optional().describe("Nodes per chunk (default 200)."),
    includeNodes: z.boolean().optional().describe("Also return a per-node list of nodes that reference the design system (default false; can be large)."),
    resolveNames: z.boolean().optional().describe("Include human-readable names (default true)."),
  },
  async ({ nodeId, chunkSize, includeNodes, resolveNames }: any) => {
    try {
      const result = await sendCommandToFigma("scan_design_usage", {
        nodeId,
        chunkSize: chunkSize || 200,
        includeNodes: !!includeNodes,
        resolveNames: resolveNames !== false,
      }, 120000); // allow up to 2 min for large trees
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error scanning design usage: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

function publishBulk(job: BulkJob): void {
  job.updatedAt = Date.now();
  if (ws?.readyState === WebSocket.OPEN) {
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
        updatedAt: job.updatedAt,
      },
    }));
  }
}

async function runBulk(job: BulkJob): Promise<void> {
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
      const result = await sendCommandToFigma(item.command, { ...(item.params || {}), batchId: job.id });
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
        projects: payload.projects || [],
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error listing Figma projects: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "get_versions",
  "Report the protocol versions of every talk-to-figma surface: this MCP server, the relay, and each connected Figma plugin (per project/channel), plus whether any MAJOR versions mismatch. Use this first when behavior seems inconsistent between surfaces — a mismatch means one of them is running stale code.",
  {},
  async () => {
    try {
      const mcp = PROTOCOL_VERSION;
      let relay: string | null = null;
      let relayError: string | undefined;
      const plugins: Array<{ project: string; channel: string; protocolVersion: string | null }> = [];
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
        [mcp, relay, ...plugins.map((p) => p.protocolVersion)]
          .map((v) => protocolMajor(v))
          .filter((m): m is number => m !== null)
      );
      const result: any = { mcp, relay, plugins, mismatch: majors.size > 1 };
      if (relayError) result.relayError = relayError;
      if (result.mismatch) result.note = "MAJOR versions differ between surfaces — update/rebuild the stale one(s) and reconnect (the relay refuses mismatched clients at handshake, so a listed mismatch usually means a surface has not reconnected since an update).";
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error getting versions: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "use_figma_project",
  "Connect this MCP client to a Figma project by project name or file key. No channel name is needed; the least-loaded healthy plugin connection is selected automatically. The response includes the project's CONTEXT DOCUMENT (page purposes, naming conventions, feature locations, misidentification traps — stored in the Figma document itself); READ IT before interpreting anything in the file.",
  { project: z.string().describe("Figma project/document name or file key") },
  async ({ project }: any) => {
    try {
      const selected = await selectProject(project);
      // Auto-load the project context document (root sharedPluginData — a few
      // ms). Best-effort: a failure here must not fail project selection.
      const CONTEXT_PREVIEW_LIMIT = 2000;
      let projectContext: any = undefined;
      try {
        const doc = await fetchProjectContextFromDocument();
        if (doc?.exists && typeof doc.content === "string") {
          const truncated = doc.content.length > CONTEXT_PREVIEW_LIMIT;
          projectContext = {
            updatedAt: doc.updatedAt ?? null,
            updatedBy: doc.updatedBy ?? null,
            content: truncated ? doc.content.slice(0, CONTEXT_PREVIEW_LIMIT) : doc.content,
            ...(truncated ? { truncated: true, note: "전체는 get_project_context 로 읽어라." } : {}),
          };
        } else {
          projectContext = {
            exists: false,
            note: "컨텍스트 문서가 아직 없다 — 파일 구조를 파악했다면 set_project_context 로 기록하라 (get_project_context 가 초안 재료를 준다).",
          };
        }
      } catch {
        // context load is best-effort
      }
      return { content: [{ type: "text", text: JSON.stringify({
        connected: true,
        project: selectedProject,
        connectionCount: selected.connectionCount,
        busy: selected.busy,
        ...(projectContext !== undefined ? { projectContext } : {}),
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
    items: z.array(z.object({
      command: z.string().describe("Figma command name"),
      params: z.record(z.unknown()).optional(),
    })).min(1),
  },
  async ({ items }: any) => {
    const job: BulkJob = {
      id: uuidv4(), status: "queued", items, completed: 0, failed: 0,
      currentIndex: null, createdAt: Date.now(), updatedAt: Date.now(), results: [], cancelRequested: false,
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
  { id: z.string() },
  async ({ id }: any) => {
    const job = bulkJobs.get(id);
    return { content: [{ type: "text", text: JSON.stringify(job || { error: "Bulk job not found", id }, null, 2) }] };
  }
);

server.tool(
  "cancel_bulk_operation",
  "Cancel a bulk job at the next item boundary. The currently executing Figma command is allowed to finish safely; remaining items will not start.",
  { id: z.string() },
  async ({ id }: any) => {
    const job = bulkJobs.get(id);
    if (!job) return { content: [{ type: "text", text: JSON.stringify({ error: "Bulk job not found", id }) }] };
    job.cancelRequested = true;
    if (job.status === "queued" || job.status === "running") job.status = "cancelling";
    publishBulk(job);
    return { content: [{ type: "text", text: JSON.stringify({ id, status: job.status }) }] };
  }
);

// List channels known to the relay, with the Figma document each is on.
// Use this to discover which channel to join when you don't already know it.
server.tool(
  "list_figma_channels",
  "List the channels on the Talk-to-Figma relay server and which Figma document each is connected to. Use this BEFORE join_channel when you don't already know the channel name: find the channel whose document matches what the user wants, then call join_channel with it. Channels where hasFigma is true have a live Figma plugin and are joinable; empty channels are kept for history and show which document they were. Returns the currently joined channel as `current`.",
  {},
  async () => {
    try {
      const httpUrl = relayHttpUrl("channels");
      const res = await fetch(httpUrl);
      if (!res.ok) throw new Error(`relay returned HTTP ${res.status}`);
      const data: any = await res.json();
      const channels = (data.channels || []).map((c: any) => ({
        channel: c.channel,
        active: !c.empty,
        hasFigma: (c.clients || []).some((cl: any) => cl.role === "figma"),
        clientRoles: (c.clients || []).map((cl: any) => cl.role),
        busy: c.busy,
        runningRequests: c.runningRequests || 0,
        pendingRequests: c.pendingRequests || 0,
        clients: (c.clients || []).map((cl: any) => ({
          id: cl.id,
          role: cl.role,
          deviceName: cl.deviceName,
          connectionScope: cl.connectionScope,
          address: cl.address,
          runningRequests: cl.runningRequests || 0,
          pendingRequests: cl.pendingRequests || 0,
        })),
        document: c.document
          ? {
              name: c.document.documentName,
              page: c.document.page,
              nodeCount: c.document.nodeCount,
              pageCount: c.document.pageCount,
              fileKey: c.document.fileKey,
            }
          : null,
        emptiedAt: c.emptiedAt,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ current: currentChannel, channels }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing channels: ${error instanceof Error ? error.message : String(error)
              }. Is the WebSocket relay running (bun socket) on port 3055?`,
          },
        ],
      };
    }
  }
);

// Update the join_channel tool
server.tool(
  "join_channel",
  "Join a specific channel to communicate with Figma",
  {
    channel: z.string().describe("The name of the channel to join").default(""),
  },
  async ({ channel }: any) => {
    try {
      if (!channel) {
        // If no channel provided, ask the user for input
        return {
          content: [
            {
              type: "text",
              text: "Please provide a channel name to join:",
            },
          ],
          followUp: {
            tool: "join_channel",
            description: "Join the specified channel",
          },
        };
      }

      await joinChannel(channel);
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${channel}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

  try {
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
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
      socket.on("error", () => undefined);
      socket.terminate();
    }
  };
  return { server, dispose };
}

const runtimeArgs = process.argv.slice(2);
const httpMode = runtimeArgs.includes("--http");
const httpPort = Number(runtimeArgs.find((arg) => arg.startsWith("--port="))?.split("=")[1] || 3056);
const httpHost = runtimeArgs.find((arg) => arg.startsWith("--host="))?.split("=")[1] || "127.0.0.1";

const exportDirectory = process.env.FIGMA_EXPORT_DIR || path.join(os.homedir(), ".macfleet", "figma-exports");
const configuredExportTTLHours = Number(process.env.FIGMA_EXPORT_TTL_HOURS || 24);
const exportTTLHours = Number.isFinite(configuredExportTTLHours) && configuredExportTTLHours > 0
  ? configuredExportTTLHours
  : 24;
const exportTTL = exportTTLHours * 60 * 60 * 1000;
const exportNamePattern = /^[0-9a-f-]{36}\.(png|jpg|svg|pdf)$/;

function cleanupExports() {
  if (!fs.existsSync(exportDirectory)) return;
  const cutoff = Date.now() - exportTTL;
  for (const name of fs.readdirSync(exportDirectory)) {
    if (!exportNamePattern.test(name)) continue;
    const file = path.join(exportDirectory, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (error) {
      logger.warn(`Could not clean export ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function exportContentType(name: string) {
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".pdf")) return "application/pdf";
  return "image/png";
}

function serveExport(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!pathname.startsWith("/files/")) return false;
  const name = pathname.slice("/files/".length);
  if (!exportNamePattern.test(name)) {
    res.writeHead(404).end("not found");
    return true;
  }
  const file = path.join(exportDirectory, name);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || Date.now() - stat.mtimeMs > exportTTL) {
      if (stat.isFile()) fs.unlinkSync(file);
      res.writeHead(404).end("not found");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": exportContentType(name),
      "Content-Length": stat.size,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
  return true;
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
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
  fs.mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
  cleanupExports();
  const cleanupTimer = setInterval(cleanupExports, Math.min(exportTTL, 60 * 60 * 1000));
  cleanupTimer.unref();

  const configuredBase = process.env.NEXUS_TUNNEL_PUBLIC_BASE || process.env.BROKER_PUBLIC_BASE;
  const remoteExportBase = (configuredBase || `http://${httpHost}:${httpPort}`).replace(/\/$/, "");
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; dispose: () => void }>();

  const httpServer = createHttpServer(async (req, res) => {
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

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let entry = sessionId ? sessions.get(sessionId) : undefined;
      let body: unknown;
      if (req.method === "POST") body = await readJSON(req);

      if (!entry && req.method === "POST" && !sessionId && isInitializeRequest(body)) {
        let transport: StreamableHTTPServerTransport;
        const { server: mcpServer, dispose } = createMcpServer({ remoteExportBase });
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: uuidv4,
          onsessioninitialized: (id) => sessions.set(id, { transport, server: mcpServer, dispose }),
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
          error: { code: -32000, message: "Invalid or missing MCP session" },
          id: null,
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(httpPort, httpHost, resolve);
  });
  logger.info(`FigmaMCP Streamable HTTP server listening on http://${httpHost}:${httpPort}/mcp`);
}

// Start the server
async function main() {
  if (httpMode) {
    await startHTTPServer();
    return;
  }
  const { server } = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('FigmaMCP server running on stdio');
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
