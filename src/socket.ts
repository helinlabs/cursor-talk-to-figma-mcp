#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { captureLocalFigmaWindow } from "./local-figma-capture";
import { applyManagedExportRetention, deleteManagedExports, listManagedExports, readManagedExport, saveManagedExport } from "./managed-exports";

const PROTOCOL_VERSION = "2.1.0";
const BINARY_MAGIC = new Uint8Array([0x54, 0x54, 0x46, 0x42]); // "TTFB"

function encodeBinaryFrame(envelope: any, payload: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(envelope));
  const frame = new Uint8Array(8 + header.byteLength + payload.byteLength);
  frame.set(BINARY_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, header.byteLength, false);
  frame.set(header, 8);
  frame.set(payload, 8 + header.byteLength);
  return frame;
}

function decodeBinaryFrame(raw: Uint8Array): { envelope: any; payload: Uint8Array } {
  if (raw.byteLength < 8 || BINARY_MAGIC.some((byte, index) => raw[index] !== byte)) {
    throw new Error("Invalid Talk-to-Figma binary frame");
  }
  const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, false);
  if (headerLength <= 0 || 8 + headerLength > raw.byteLength) {
    throw new Error("Invalid Talk-to-Figma binary header length");
  }
  const envelope = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLength)));
  return { envelope, payload: raw.subarray(8 + headerLength) };
}

function isProtocolCompatible(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const expectedMajor = Number(PROTOCOL_VERSION.split(".")[0]);
  const receivedMajor = Number(version.split(".")[0]);
  return Number.isInteger(receivedMajor) && receivedMajor === expectedMajor;
}

function protocolMismatchMessage(received: unknown): string {
  return `Talk-to-Figma protocol mismatch: relay=${PROTOCOL_VERSION}, client=${received || "missing"}. Update/rebuild the MCP server and re-run the Figma development plugin, then reconnect.`;
}

// Build id served to the plugin UI (GET /plugin-version): a content hash of the
// on-disk plugin files. Lets the plugin show which code is loaded WITHOUT
// baking a version into the source (nothing committed per build). Computed per
// request so edits are reflected without restarting the relay.
function pluginVersion(): string {
  try {
    const code = readFileSync(new URL("./cursor_mcp_plugin/code.js", import.meta.url), "utf8");
    const ui = readFileSync(new URL("./cursor_mcp_plugin/ui.html", import.meta.url), "utf8")
      // neutralize the build-id span so it can't affect its own hash
      .replace(/(<span id="build-id">)(.*?)(<\/span>)/, "$1$3");
    return createHash("sha256").update(code).update(ui).digest("hex").slice(0, 7);
  } catch (e) {
    return "unknown";
  }
}

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// ---------------------------------------------------------------------------
// Monitoring / Web console state
// ---------------------------------------------------------------------------

interface ClientMeta {
  id: string;
  role: "unknown" | "controller" | "figma" | "monitor";
  channel: string | null;
  connectedAt: number;
  lastSeenAt: number;
  isMonitor: boolean;
  lastCommand?: string;
  requesterId?: string;
  activeRequests: number;
  recentTimeouts: boolean[];
  unstable: boolean;
  applicationHeartbeat: boolean;
  protocolVersion?: string;
  protocolVerified: boolean;
  deviceName?: string;
  platform?: string;
  address?: string;
  observedAddress?: string;
  connectionScope: "localhost" | "lan" | "external" | "unknown";
  capabilities: Set<string>;
}

interface ConnectionData {
  address?: string;
  observedAddress?: string;
  connectionScope: ClientMeta["connectionScope"];
}

interface RequestMeta {
  id: string;
  channel: string;
  command: string;
  requester: ServerWebSocket<any>;
  requesterId: string;
  figma?: ServerWebSocket<any>;
  queuedAt: number;
  dispatchedAt?: number;
  startedAt?: number;
  batchId?: string;
}

// Per-socket metadata (id, inferred role, current channel, …)
const clientMeta = new Map<ServerWebSocket<any>, ClientMeta>();

// Sockets that opened the web console and want the live event stream
const monitors = new Set<ServerWebSocket<any>>();
const requests = new Map<string, RequestMeta>();
const bulkJobs = new Map<string, any>();
type PreviewMode = "app-window" | "node-export";
interface PreviewSubscription { channel: string; mode: PreviewMode }
const previewSubscriptions = new Map<ServerWebSocket<any>, PreviewSubscription>();
let localPreviewTimer: ReturnType<typeof setInterval> | null = null;
let localPreviewBusy = false;

// Ring buffer of recent events so a freshly-opened console sees history.
// The browser console keeps a much larger buffer; this is just the backlog
// handed to a console when it first connects.
const eventLog: any[] = [];
const MAX_LOG = 1000;

let clientSeq = 0;

// Channels that have gone empty are kept around (so the console can show a
// history of past sessions) but capped so they don't grow unbounded.
// name -> timestamp it became empty
const emptyChannels = new Map<string, number>();
const MAX_EMPTY = 50;

// name -> document identity announced by the Figma plugin on that channel
const channelDocs = new Map<string, any>();
const channelAnnouncedAt = new Map<string, number>();

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const UNSTABLE_WINDOW = 10;
const UNSTABLE_TIMEOUT_RATE = 0.5;

try { applyManagedExportRetention(); } catch (error) { console.warn("Managed export retention failed:", error); }
setInterval(() => {
  try { applyManagedExportRetention(); } catch (error) { console.warn("Managed export retention failed:", error); }
}, 60 * 60 * 1000);

function connectionScope(address?: string): ClientMeta["connectionScope"] {
  if (!address) return "unknown";
  const value = address.trim().replace(/^::ffff:/, "").toLowerCase();
  if (value === "localhost" || value === "127.0.0.1" || value === "::1") return "localhost";
  if (/^10\./.test(value) || /^192\.168\./.test(value)) return "lan";
  const match = value.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return "lan";
  if (/^(fc|fd)[0-9a-f]{2}:/.test(value) || /^fe80:/.test(value)) return "lan";
  return "external";
}

function touch(ws: ServerWebSocket<any>): void {
  const meta = clientMeta.get(ws);
  if (meta) meta.lastSeenAt = Date.now();
}

function recordFigmaOutcome(ws: ServerWebSocket<any> | undefined, timedOut: boolean): void {
  if (!ws) return;
  const meta = clientMeta.get(ws);
  if (!meta) return;
  meta.recentTimeouts.push(timedOut);
  if (meta.recentTimeouts.length > UNSTABLE_WINDOW) meta.recentTimeouts.shift();
  const rate = meta.recentTimeouts.filter(Boolean).length / meta.recentTimeouts.length;
  meta.unstable = meta.recentTimeouts.length >= UNSTABLE_WINDOW && rate >= UNSTABLE_TIMEOUT_RATE;
  if (meta.unstable) {
    pushEvent({ kind: "unstable", clientId: meta.id, channel: meta.channel, timeoutRate: rate });
    ws.close(4002, "Figma connection classified as unstable");
  }
}

function leaveChannel(ws: ServerWebSocket<any>, channelName: string): void {
  const clients = channels.get(channelName);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) {
    emptyChannels.set(channelName, Date.now());
    pruneEmptyChannels();
  }
}

function chooseFigma(channelName: string): ServerWebSocket<any> | undefined {
  return [...(channels.get(channelName) ?? [])]
    .filter((client) => {
      const meta = clientMeta.get(client);
      return client.readyState === WebSocket.OPEN && meta?.role === "figma" && !meta.unstable;
    })
    .sort((a, b) => {
      const am = clientMeta.get(a)!;
      const bm = clientMeta.get(b)!;
      return am.activeRequests - bm.activeRequests || bm.connectedAt - am.connectedAt;
    })[0];
}

function previewSubscriberCount(channelName: string): number {
  return [...previewSubscriptions.values()].filter((subscription) => subscription.channel === channelName).length;
}

function nodePreviewSubscriberCount(channelName: string): number {
  return [...previewSubscriptions.values()].filter((subscription) =>
    subscription.channel === channelName && subscription.mode === "node-export"
  ).length;
}

function sendPreviewControl(channelName: string, enabled: boolean): void {
  const figma = chooseFigma(channelName);
  if (figma?.readyState === WebSocket.OPEN) {
    figma.send(JSON.stringify({ type: "preview_control", channel: channelName, enabled }));
  }
}

function sendPreviewError(channelName: string, mode: PreviewMode, error: unknown): void {
  for (const [subscriber, subscription] of previewSubscriptions) {
    if (subscription.channel === channelName && subscription.mode === mode && subscriber.readyState === WebSocket.OPEN) {
      subscriber.send(JSON.stringify({ kind: "preview_error", channel: channelName, mode, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

async function captureLocalAppPreviews(): Promise<void> {
  if (localPreviewBusy) return;
  localPreviewBusy = true;
  try {
    const channelsToCapture = [...new Set(
      [...previewSubscriptions.values()]
        .filter((subscription) => subscription.mode === "app-window")
        .map((subscription) => subscription.channel)
    )];
    for (const channelName of channelsToCapture) {
      try {
        const document = channelDocs.get(channelName);
        const capture = await captureLocalFigmaWindow(document?.documentName, 1400);
        const preview = {
          source: "app-window",
          mimeType: capture.mimeType,
          windowName: capture.windowName,
          pageName: document?.page,
          width: capture.width,
          height: capture.height,
          byteLength: capture.bytes.byteLength,
          capturedAt: capture.capturedAt,
        };
        const envelope = { kind: "preview_frame", channel: channelName, preview };
        const frame = encodeBinaryFrame(envelope, capture.bytes);
        for (const [subscriber, subscription] of previewSubscriptions) {
          if (subscription.channel !== channelName || subscription.mode !== "app-window" || subscriber.readyState !== WebSocket.OPEN) continue;
          if (clientMeta.get(subscriber)?.capabilities.has("binaryFrames")) {
            subscriber.send(frame);
          } else {
            subscriber.send(JSON.stringify({ ...envelope, preview: { ...preview, imageData: capture.bytes.toString("base64") } }));
          }
        }
      } catch (error) {
        sendPreviewError(channelName, "app-window", error);
      }
    }
  } finally {
    localPreviewBusy = false;
  }
}

function refreshLocalPreviewLoop(): void {
  const needed = [...previewSubscriptions.values()].some((subscription) => subscription.mode === "app-window");
  if (needed && !localPreviewTimer) {
    void captureLocalAppPreviews();
    localPreviewTimer = setInterval(() => void captureLocalAppPreviews(), 2000);
  } else if (!needed && localPreviewTimer) {
    clearInterval(localPreviewTimer);
    localPreviewTimer = null;
  }
}

function pruneEmptyChannels(): void {
  if (emptyChannels.size <= MAX_EMPTY) return;
  const oldestFirst = [...emptyChannels.entries()].sort((a, b) => a[1] - b[1]);
  while (emptyChannels.size > MAX_EMPTY) {
    const [name] = oldestFirst.shift()!;
    emptyChannels.delete(name);
    channels.delete(name);
    channelDocs.delete(name);
  }
}

// Load the web console HTML once at startup (served at GET /console and /)
let CONSOLE_HTML = "<h1>console.html not found</h1>";
try {
  CONSOLE_HTML = await Bun.file(new URL("./console.html", import.meta.url)).text();
} catch (err) {
  console.error("Could not load console.html:", err);
}

// Truncate large payloads before they go into the log / monitor stream so the
// console stays responsive even with big get_document_info style responses.
function truncate(value: unknown, max = 4000): unknown {
  if (value === undefined || value === null) return value;
  let str: string;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (str.length <= max) return value;
  return { __truncated: true, length: str.length, preview: str.slice(0, max) };
}

function sanitizeForLog(value: any, depth = 0): any {
  if (depth > 6) return "[depth omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(imageData|imageBase64|imageBytes|data)$/i.test(key)) {
      const bytes = ArrayBuffer.isView(child)
        ? child.byteLength
        : child instanceof ArrayBuffer
          ? child.byteLength
          : undefined;
      out[key] = typeof child === "string"
        ? { omitted: true, encodedCharacters: child.length }
        : { omitted: true, ...(bytes === undefined ? {} : { bytes }) };
    } else {
      out[key] = sanitizeForLog(child, depth + 1);
    }
  }
  return out;
}

function pushEvent(evt: any): void {
  evt.ts = evt.ts ?? Date.now();
  eventLog.push(evt);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  const data = JSON.stringify({ kind: "event", event: evt });
  monitors.forEach((m) => {
    if (m.readyState === WebSocket.OPEN) m.send(data);
  });
}

function snapshotChannels(): any[] {
  const out: any[] = [];
  channels.forEach((clients, name) => {
    const members: any[] = [];
    clients.forEach((c) => {
      const m = clientMeta.get(c);
      if (m) {
        const assigned = [...requests.values()].filter((request) => request.figma === c);
        members.push({
        id: m.id,
        role: m.role,
        connectedAt: m.connectedAt,
        lastSeenAt: m.lastSeenAt,
        requesterId: m.requesterId ?? null,
        activeRequests: m.activeRequests,
        unstable: m.unstable,
        protocolVersion: m.protocolVersion ?? null,
        capabilities: [...m.capabilities],
        deviceName: m.deviceName ?? null,
        platform: m.platform ?? null,
        address: m.address ?? null,
        observedAddress: m.observedAddress ?? null,
        connectionScope: m.connectionScope,
        runningRequests: assigned.filter((request) => request.startedAt !== undefined).length,
        pendingRequests: assigned.filter((request) => request.startedAt === undefined).length,
      });
      }
    });
    const channelRequests = [...requests.values()].filter((request) => request.channel === name);
    const runningRequests = channelRequests.filter((request) => request.startedAt !== undefined).length;
    const pendingRequests = channelRequests.length - runningRequests;
    out.push({
      channel: name,
      count: members.length,
      clients: members,
      empty: members.length === 0,
      emptiedAt: emptyChannels.get(name) ?? null,
      document: channelDocs.get(name) ?? null,
      announcedAt: channelAnnouncedAt.get(name) ?? null,
      busy: runningRequests > 0,
      runningRequests,
      pendingRequests,
      inFlightRequests: channelRequests.length,
      queueDepth: pendingRequests,
      previewSubscribers: previewSubscriberCount(name),
    });
  });
  return out;
}

function snapshotProjects(): any[] {
  const groups = new Map<string, any[]>();
  for (const channel of snapshotChannels()) {
    if (!channel.document) continue;
    const key = channel.document.fileKey || channel.document.documentName || channel.channel;
    const list = groups.get(key) ?? [];
    list.push(channel);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([projectKey, connections]) => {
    const live = connections.filter((connection) =>
      connection.clients.some((client: any) => client.role === "figma" && !client.unstable)
    );
    const newest = [...live].sort((a, b) => (b.announcedAt || 0) - (a.announcedAt || 0))[0] ?? null;
    const leastLoaded = [...live].sort((a, b) => {
      const ac = a.clients.filter((client: any) => client.role === "controller").length;
      const bc = b.clients.filter((client: any) => client.role === "controller").length;
      return ac - bc || a.inFlightRequests - b.inFlightRequests || (b.announcedAt || 0) - (a.announcedAt || 0);
    })[0] ?? null;
    const document = (newest || connections[0]).document;
    return {
      projectKey,
      name: document.documentName,
      fileKey: document.fileKey ?? null,
      connectionCount: live.length,
      totalConnectionCount: connections.length,
      representativeChannel: newest?.channel ?? null,
      recommendedChannel: leastLoaded?.channel ?? null,
      busy: live.some((connection) => connection.busy),
      runningRequests: live.reduce((sum, connection) => sum + connection.runningRequests, 0),
      pendingRequests: live.reduce((sum, connection) => sum + connection.pendingRequests, 0),
      inFlightRequests: live.reduce((sum, connection) => sum + connection.inFlightRequests, 0),
      connections,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function pushChannels(): void {
  const data = JSON.stringify({
    kind: "channels",
    protocolVersion: PROTOCOL_VERSION,
    channels: snapshotChannels(),
    projects: snapshotProjects(),
    bulkJobs: [...bulkJobs.values()],
  });
  monitors.forEach((m) => {
    if (m.readyState === WebSocket.OPEN) m.send(data);
  });
}

// ---------------------------------------------------------------------------

function handleConnection(ws: ServerWebSocket<any>) {
  const connection = (ws.data || {}) as ConnectionData;
  const meta: ClientMeta = {
    id: `c${++clientSeq}`,
    role: "unknown",
    channel: null,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    isMonitor: false,
    activeRequests: 0,
    recentTimeouts: [],
    unstable: false,
    applicationHeartbeat: false,
    protocolVerified: false,
    address: connection.address,
    observedAddress: connection.observedAddress,
    connectionScope: connection.connectionScope || "unknown",
    capabilities: new Set(),
  };
  clientMeta.set(ws, meta);

  console.log(`New client connected (${meta.id})`);

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));

  pushEvent({ kind: "connect", clientId: meta.id, address: meta.address, connectionScope: meta.connectionScope });
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 3055,
  hostname: process.env.HOST || "0.0.0.0",
  async fetch(req: Request, server: Server) {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Figma-Export-Name, X-Figma-Export-Extension",
        },
      });
    }

    // Handle WebSocket upgrade first (clients connect to the root path).
    // For plain HTTP GETs this returns false and we fall through to serving
    // the web console below.
    const observedAddress = server.requestIP(req)?.address;
    const forwarded = req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const address = forwarded || observedAddress;
    const success = server.upgrade(req, {
      data: { address, observedAddress, connectionScope: connectionScope(address) } satisfies ConnectionData,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

    if (success) {
      return; // Upgraded to WebSocket
    }

    // Serve the monitoring web console for normal browser requests
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/console") {
      return new Response(CONSOLE_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // JSON list of channels + their document identity (for controllers/tools)
    if (url.pathname === "/channels") {
      return new Response(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, channels: snapshotChannels(), projects: snapshotProjects() }, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/projects") {
      return new Response(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, projects: snapshotProjects() }, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/status") {
      return new Response(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        projects: snapshotProjects(),
        requestsInFlight: requests.size,
        bulkJobs: [...bulkJobs.values()],
      }, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/exports" && req.method === "GET") {
      return new Response(JSON.stringify(listManagedExports(), null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === "/exports" && req.method === "POST") {
      try {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.byteLength || bytes.byteLength > 64 * 1024 * 1024) throw new Error("Export must be between 1 byte and 64 MB");
        const target = saveManagedExport(
          bytes,
          decodeURIComponent(req.headers.get("x-figma-export-name") || "figma-export"),
          req.headers.get("x-figma-export-extension") || "png",
        );
        const gallery = listManagedExports();
        const file = gallery.files.find((item) => target.endsWith(item.name));
        return new Response(JSON.stringify({ saved: true, path: target, file }, null, 2), {
          status: 201,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    if (url.pathname === "/exports" && req.method === "DELETE") {
      const daysParam = url.searchParams.get("olderThanDays");
      const result = deleteManagedExports(daysParam === null ? undefined : Math.max(0, Number(daysParam) || 0));
      return new Response(JSON.stringify({ ...result, gallery: listManagedExports() }, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname.startsWith("/exports/file/") && req.method === "GET") {
      try {
        const name = decodeURIComponent(url.pathname.slice("/exports/file/".length));
        const file = readManagedExport(name);
        return new Response(file.bytes, { headers: { "Content-Type": file.mimeType, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
      } catch {
        return new Response("Export not found", { status: 404 });
      }
    }

    // Build id of the on-disk plugin files (for the plugin UI's version badge).
    if (url.pathname === "/plugin-version") {
      return new Response(JSON.stringify({ build: pluginVersion(), protocolVersion: PROTOCOL_VERSION }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Return response for non-WebSocket requests
    return new Response("WebSocket server running", {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
  websocket: {
    maxPayloadLength: 64 * 1024 * 1024,
    open: handleConnection,
    pong(ws: ServerWebSocket<any>) {
      // For Figma, require the application-level heartbeat from the plugin UI.
      // A protocol pong can still arrive while a backgrounded UI is frozen.
      if (!clientMeta.get(ws)?.applicationHeartbeat) touch(ws);
    },
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        let data: any;
        let binaryPayload: Uint8Array | undefined;
        if (typeof message === "string") {
          data = JSON.parse(message);
        } else {
          const decoded = decodeBinaryFrame(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
          data = decoded.envelope;
          binaryPayload = decoded.payload;
        }
        const meta = clientMeta.get(ws);
        touch(ws);

        if (data.type === "heartbeat") {
          if (meta) {
            if (data.requesterId) meta.requesterId = String(data.requesterId);
            if (data.role === "figma") meta.applicationHeartbeat = true;
          }
          ws.send(JSON.stringify({ type: "heartbeat_ack", ts: Date.now() }));
          return;
        }

        if (data.type === "hello") {
          if (meta) {
            meta.requesterId = data.requesterId ? String(data.requesterId) : meta.requesterId;
            if (data.role === "controller" || data.role === "figma") meta.role = data.role;
            if (data.role === "figma") meta.applicationHeartbeat = true;
            if (data.deviceName) meta.deviceName = String(data.deviceName).slice(0, 120);
            if (data.platform) meta.platform = String(data.platform).slice(0, 160);
            meta.capabilities = new Set(Array.isArray(data.capabilities) ? data.capabilities.map(String) : []);
            meta.protocolVersion = typeof data.protocolVersion === "string" ? data.protocolVersion : undefined;
            meta.protocolVerified = isProtocolCompatible(data.protocolVersion);
            if (!meta.protocolVerified) {
              const message = protocolMismatchMessage(data.protocolVersion);
              ws.send(JSON.stringify({
                type: "system",
                event: "protocol_mismatch",
                message,
                expectedProtocolVersion: PROTOCOL_VERSION,
                receivedProtocolVersion: data.protocolVersion ?? null,
              }));
              pushEvent({ kind: "protocol_mismatch", clientId: meta.id, requesterId: meta.requesterId, receivedProtocolVersion: data.protocolVersion ?? null, expectedProtocolVersion: PROTOCOL_VERSION });
              ws.close(4003, "Protocol version mismatch");
              return;
            }
            ws.send(JSON.stringify({
              type: "system",
              event: "hello_ack",
              protocolVersion: PROTOCOL_VERSION,
              capabilities: ["binaryFrames", "livePreview"],
            }));
          }
          pushChannels();
          return;
        }

        if (data.type === "bulk_status") {
          const job = { ...data.job, requesterId: meta?.requesterId ?? meta?.id, updatedAt: Date.now() };
          if (job.id) bulkJobs.set(job.id, job);
          pushEvent({ kind: "bulk", ...job });
          pushChannels();
          return;
        }

        if (data.type === "preview_subscribe") {
          if (!meta?.isMonitor) return;
          const nextChannel = typeof data.channel === "string" && data.channel ? data.channel : null;
          if (nextChannel && !channels.has(nextChannel)) return;
          const nextMode: PreviewMode = data.mode === "node-export" ? "node-export" : "app-window";
          const previous = previewSubscriptions.get(ws);
          if (previous?.channel === nextChannel && previous.mode === nextMode) return;
          if (previous) previewSubscriptions.delete(ws);
          if (previous?.mode === "node-export" && nodePreviewSubscriberCount(previous.channel) === 0) {
            sendPreviewControl(previous.channel, false);
          }
          if (nextChannel) {
            previewSubscriptions.set(ws, { channel: nextChannel, mode: nextMode });
            if (nextMode === "node-export") sendPreviewControl(nextChannel, true);
          }
          refreshLocalPreviewLoop();
          pushChannels();
          return;
        }

        if (data.type === "preview_frame") {
          if (!meta || meta.role !== "figma" || meta.channel !== data.channel) return;
          const preview = { ...(data.preview || {}) };
          delete preview.imageData;
          for (const [subscriber, subscription] of previewSubscriptions) {
            if (subscription.channel !== data.channel || subscription.mode !== "node-export" || subscriber.readyState !== WebSocket.OPEN) continue;
            const subscriberMeta = clientMeta.get(subscriber);
            const envelope = { kind: "preview_frame", channel: subscription.channel, preview };
            if (binaryPayload && subscriberMeta?.capabilities.has("binaryFrames")) {
              subscriber.send(encodeBinaryFrame(envelope, binaryPayload));
            } else if (binaryPayload) {
              subscriber.send(JSON.stringify({
                ...envelope,
                preview: { ...preview, imageData: Buffer.from(binaryPayload).toString("base64") },
              }));
            } else if (typeof data.preview?.imageData === "string") {
              subscriber.send(JSON.stringify({ ...envelope, preview: data.preview }));
            }
          }
          return;
        }

        if (data.type === "preview_error") {
          for (const [subscriber, subscription] of previewSubscriptions) {
            if (subscription.channel === data.channel && subscription.mode === "node-export" && subscriber.readyState === WebSocket.OPEN) {
              subscriber.send(JSON.stringify({ kind: "preview_error", channel: subscription.channel, mode: subscription.mode, error: data.error }));
            }
          }
          return;
        }

        if (data.type === "execution_started") {
          const request = requests.get(data.id);
          if (request && request.figma === ws) {
            request.startedAt = Date.now();
            pushEvent({
              kind: "started",
              clientId: meta?.id,
              requesterId: request.requesterId,
              channel: request.channel,
              commandId: request.id,
              command: request.command,
              waitMs: request.startedAt - request.queuedAt,
              batchId: request.batchId,
            });
            pushChannels();
          }
          return;
        }

        if (data.type === "request_timeout") {
          const request = requests.get(data.id);
          if (request && request.requester === ws) {
            const figmaMeta = request.figma ? clientMeta.get(request.figma) : undefined;
            if (figmaMeta) figmaMeta.activeRequests = Math.max(0, figmaMeta.activeRequests - 1);
            recordFigmaOutcome(request.figma, true);
            requests.delete(data.id);
            pushEvent({ kind: "timeout", requesterId: request.requesterId, clientId: figmaMeta?.id, channel: request.channel, commandId: request.id, command: request.command });
            pushChannels();
          }
          return;
        }

        // --- Monitoring console registration ---------------------------------
        if (data.type === "monitor") {
          if (meta) {
            meta.isMonitor = true;
            meta.role = "monitor";
          }
          monitors.add(ws);
          ws.send(JSON.stringify({
            kind: "snapshot",
            protocolVersion: PROTOCOL_VERSION,
            channels: snapshotChannels(),
            projects: snapshotProjects(),
            bulkJobs: [...bulkJobs.values()],
            log: eventLog,
          }));
          console.log(`\n👁  Monitor connected (${meta?.id})`);
          return;
        }

        // --- Console action: drop all empty (clientless) channels -----------
        if (data.type === "clear_empty") {
          let removed = 0;
          for (const [name, set] of channels) {
            if (set.size === 0) {
              channels.delete(name);
              emptyChannels.delete(name);
              channelDocs.delete(name);
              removed++;
            }
          }
          console.log(`\n🧹 Cleared ${removed} empty channel(s)`);
          pushChannels();
          return;
        }

        // --- Document identity announcement from the Figma plugin ------------
        if (data.type === "announce") {
          const channelName = data.channel;
          const channelClients = channels.get(channelName);
          if (!channelName || !channelClients || !channelClients.has(ws)) return;
          channelDocs.set(channelName, data.document);
          channelAnnouncedAt.set(channelName, Date.now());
          if (meta) meta.role = "figma"; // only the plugin announces a document
          if (nodePreviewSubscriberCount(channelName) > 0) sendPreviewControl(channelName, true);
          console.log(`\n📄 Channel "${channelName}" → document:`, JSON.stringify(data.document));
          pushEvent({ kind: "document", clientId: meta?.id, channel: channelName, document: data.document });
          pushChannels();
          return;
        }

        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || 'N/A'}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Message metadata:`, JSON.stringify({
          ...sanitizeForLog(data),
          ...(binaryPayload ? { binaryTransfer: { bytes: binaryPayload.byteLength } } : {}),
        }, null, 2));

        if (data.type === "join") {
          if (!meta?.protocolVerified) {
            const message = protocolMismatchMessage(meta?.protocolVersion);
            ws.send(JSON.stringify({
              type: "system",
              event: "protocol_mismatch",
              message,
              expectedProtocolVersion: PROTOCOL_VERSION,
              receivedProtocolVersion: meta?.protocolVersion ?? null,
            }));
            ws.close(4003, "Protocol version mismatch");
            return;
          }
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          if (meta?.channel && meta.channel !== channelName) leaveChannel(ws, meta.channel);

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);
          emptyChannels.delete(channelName); // active again
          if (meta) {
            meta.channel = channelName;
            meta.requesterId = data.requesterId || data.message?.params?.requesterId || meta.requesterId;
            // Infer role from the join message shape so it's known immediately
            // (before any command/response traffic):
            //   - MCP server / console tester join with message.command === "join"
            //   - the Figma plugin sends a bare { type:"join", channel }
            if (meta.role === "unknown" || meta.role === "monitor") {
              meta.role = data.message?.command === "join" ? "controller" : "figma";
            }
          }

          console.log(`\n✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

          pushEvent({
            kind: "join",
            clientId: meta?.id,
            channel: channelName,
            clientCount: channelClients.size,
          });
          pushChannels();

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          if (data.message?.command) {
            if (meta) {
              meta.role = "controller";
              meta.lastCommand = data.message.command;
            }
            const requestId = data.message.id || data.id;
            const figma = chooseFigma(channelName);
            if (!figma) {
              ws.send(JSON.stringify({
                type: "broadcast",
                channel: channelName,
                message: { id: requestId, error: "No healthy Figma plugin is available for this project", result: {} },
              }));
              return;
            }
            const figmaMeta = clientMeta.get(figma)!;
            const queuedAt = Date.now();
            const request: RequestMeta = {
              id: requestId,
              channel: channelName,
              command: data.message.command,
              requester: ws,
              requesterId: meta?.requesterId ?? meta?.id ?? "unknown",
              figma,
              queuedAt,
              dispatchedAt: queuedAt,
              batchId: data.message.params?.batchId,
            };
            requests.set(requestId, request);
            figmaMeta.activeRequests++;
            pushEvent({
              kind: "command",
              clientId: meta?.id,
              requesterId: request.requesterId,
              figmaClientId: figmaMeta.id,
              channel: channelName,
              commandId: requestId,
              command: data.message.command,
              params: truncate(data.message.params),
              batchId: request.batchId,
              queueDepth: figmaMeta.activeRequests,
            });
            figma.send(JSON.stringify({
              type: "broadcast",
              message: data.message,
              sender: request.requesterId,
              channel: channelName,
            }));
            pushChannels();
            return;
          } else if (
            data.message?.result !== undefined ||
            data.message?.error !== undefined
          ) {
            if (meta) meta.role = "figma";
            const isError = data.message.error !== undefined && data.message.error !== null;
            const requestId = data.message.id || data.id;
            const request = requests.get(requestId);
            if (!request || request.figma !== ws) return;
            const completedAt = Date.now();
            const startedAt = request.startedAt ?? request.dispatchedAt ?? request.queuedAt;
            const timing = {
              waitMs: startedAt - request.queuedAt,
              executionMs: completedAt - startedAt,
              totalMs: completedAt - request.queuedAt,
            };
            if (meta) meta.activeRequests = Math.max(0, meta.activeRequests - 1);
            recordFigmaOutcome(ws, false);
            pushEvent({
              kind: "result",
              clientId: meta?.id,
              requesterId: request.requesterId,
              channel: channelName,
              commandId: requestId,
              command: request.command,
              ok: !isError,
              result: truncate(data.message.result),
              error: data.message.error,
              timing,
              batchId: request.batchId,
              transfer: binaryPayload ? { encoding: "binary", bytes: binaryPayload.byteLength } : undefined,
            });
            if (request.requester.readyState === WebSocket.OPEN) {
              const responseEnvelope = {
                type: "broadcast",
                message: { ...data.message, timing },
                sender: meta?.id ?? "figma",
                channel: channelName,
              };
              if (binaryPayload) {
                const requesterMeta = clientMeta.get(request.requester);
                if (requesterMeta?.capabilities.has("binaryFrames")) {
                  request.requester.send(encodeBinaryFrame(responseEnvelope, binaryPayload));
                } else {
                  responseEnvelope.message.result = {
                    ...responseEnvelope.message.result,
                    binary: false,
                    imageData: Buffer.from(binaryPayload).toString("base64"),
                  };
                  request.requester.send(JSON.stringify(responseEnvelope));
                }
              } else {
                request.requester.send(JSON.stringify(responseEnvelope));
              }
            }
            requests.delete(requestId);
            pushChannels();
            return;
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          pushEvent({
            kind: "progress",
            clientId: meta?.id,
            channel: channelName,
            commandId: data.id,
            progress: data.message?.data?.progress,
            status: data.message?.data?.status,
            message: data.message?.data?.message,
            commandType: data.message?.data?.commandType,
          });

          const request = requests.get(data.id);
          if (request && request.figma === ws && request.requester.readyState === WebSocket.OPEN) {
            request.requester.send(JSON.stringify(data));
          }
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<any>) {
      const meta = clientMeta.get(ws);

      monitors.delete(ws);
      const previewSubscription = previewSubscriptions.get(ws);
      previewSubscriptions.delete(ws);
      if (previewSubscription?.mode === "node-export" && nodePreviewSubscriberCount(previewSubscription.channel) === 0) {
        sendPreviewControl(previewSubscription.channel, false);
      }
      refreshLocalPreviewLoop();

      for (const [id, request] of requests) {
        if (request.requester === ws) {
          const figmaMeta = request.figma ? clientMeta.get(request.figma) : undefined;
          if (figmaMeta) figmaMeta.activeRequests = Math.max(0, figmaMeta.activeRequests - 1);
          requests.delete(id);
        } else if (request.figma === ws) {
          if (request.requester.readyState === WebSocket.OPEN) {
            request.requester.send(JSON.stringify({
              type: "broadcast",
              channel: request.channel,
              message: { id, error: "Figma plugin disconnected while executing the request", result: {} },
            }));
          }
          requests.delete(id);
        }
      }

      // Remove client from their channel(s) and notify peers
      channels.forEach((clients, channelName) => {
        if (clients.has(ws)) {
          clients.delete(ws);

          clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A user has left the channel",
                channel: channelName
              }));
            }
          });

          // When the Figma plugin leaves, the channel can no longer do anything
          // useful (no one to execute commands), so evict the remaining
          // clients from it. Skip if another Figma client is still present.
          if (meta && meta.role === "figma" && clients.size > 0) {
            let figmaRemains = false;
            clients.forEach((c) => {
              const cm = clientMeta.get(c);
              if (cm && cm.role === "figma") figmaRemains = true;
            });
            if (!figmaRemains) {
              const evictedCount = clients.size;
              clients.forEach((c) => {
                if (c.readyState === WebSocket.OPEN) {
                  c.send(JSON.stringify({
                    type: "system",
                    event: "channel_closed",
                    message: "Figma left the channel; channel closed.",
                    channel: channelName,
                  }));
                }
                const cm = clientMeta.get(c);
                if (cm) cm.channel = null;
              });
              clients.clear();
              console.log(`\n🚪 Figma left "${channelName}" → evicted ${evictedCount} remaining client(s)`);
              pushEvent({ kind: "channel_closed", channel: channelName, reason: "figma_left", evicted: evictedCount });
            }
          }

          // Keep the (now empty) channel around so its history stays visible
          // in the console, but mark it empty and prune old ones.
          if (clients.size === 0) {
            emptyChannels.set(channelName, Date.now());
            pruneEmptyChannels();
          } else if (meta?.role === "figma" && nodePreviewSubscriberCount(channelName) > 0) {
            sendPreviewControl(channelName, true);
          }
        }
      });

      console.log(`Client disconnected (${meta?.id})`);

      if (meta) {
        pushEvent({ kind: "disconnect", clientId: meta.id, channel: meta.channel });
      }
      clientMeta.delete(ws);
      pushChannels();
    }
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [client, meta] of clientMeta) {
    if (meta.role === "monitor") continue;
    if (now - meta.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      pushEvent({ kind: "heartbeat_timeout", clientId: meta.id, requesterId: meta.requesterId, channel: meta.channel });
      client.close(4001, "Heartbeat timeout");
      continue;
    }
    try {
      client.ping(String(now));
    } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);

console.log(`WebSocket server running on port ${server.port}`);
console.log(`Web console available at http://localhost:${server.port}/console`);
