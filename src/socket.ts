#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";

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
  isMonitor: boolean;
  lastCommand?: string;
}

// Per-socket metadata (id, inferred role, current channel, …)
const clientMeta = new Map<ServerWebSocket<any>, ClientMeta>();

// Sockets that opened the web console and want the live event stream
const monitors = new Set<ServerWebSocket<any>>();

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
      if (m) members.push({ id: m.id, role: m.role, connectedAt: m.connectedAt });
    });
    out.push({
      channel: name,
      count: members.length,
      clients: members,
      empty: members.length === 0,
      emptiedAt: emptyChannels.get(name) ?? null,
      document: channelDocs.get(name) ?? null,
    });
  });
  return out;
}

function pushChannels(): void {
  const data = JSON.stringify({ kind: "channels", channels: snapshotChannels() });
  monitors.forEach((m) => {
    if (m.readyState === WebSocket.OPEN) m.send(data);
  });
}

// ---------------------------------------------------------------------------

function handleConnection(ws: ServerWebSocket<any>) {
  const meta: ClientMeta = {
    id: `c${++clientSeq}`,
    role: "unknown",
    channel: null,
    connectedAt: Date.now(),
    isMonitor: false,
  };
  clientMeta.set(ws, meta);

  console.log(`New client connected (${meta.id})`);

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));

  pushEvent({ kind: "connect", clientId: meta.id });
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 3055,
  // uncomment this to allow connections in windows wsl
  // hostname: "0.0.0.0",
  fetch(req: Request, server: Server) {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Handle WebSocket upgrade first (clients connect to the root path).
    // For plain HTTP GETs this returns false and we fall through to serving
    // the web console below.
    const success = server.upgrade(req, {
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
      return new Response(JSON.stringify({ channels: snapshotChannels() }, null, 2), {
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
    open: handleConnection,
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        const data = JSON.parse(message as string);
        const meta = clientMeta.get(ws);

        // --- Monitoring console registration ---------------------------------
        if (data.type === "monitor") {
          if (meta) {
            meta.isMonitor = true;
            meta.role = "monitor";
          }
          monitors.add(ws);
          ws.send(JSON.stringify({
            kind: "snapshot",
            channels: snapshotChannels(),
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
          if (meta) meta.role = "figma"; // only the plugin announces a document
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
        console.log(`Full message:`, JSON.stringify(data, null, 2));

        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

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

          // Log command / response traffic for the monitoring console and
          // infer the sender's role from the message shape.
          if (data.message?.command) {
            if (meta) {
              meta.role = "controller";
              meta.lastCommand = data.message.command;
            }
            pushEvent({
              kind: "command",
              clientId: meta?.id,
              channel: channelName,
              commandId: data.message.id,
              command: data.message.command,
              params: truncate(data.message.params),
            });
          } else if (
            data.message?.result !== undefined ||
            data.message?.error !== undefined
          ) {
            if (meta) meta.role = "figma";
            const isError = data.message.error !== undefined && data.message.error !== null;
            pushEvent({
              kind: "result",
              clientId: meta?.id,
              channel: channelName,
              commandId: data.message.id,
              ok: !isError,
              result: truncate(data.message.result),
              error: data.message.error,
            });
          }

          // Broadcast to all OTHER clients in the channel (not the sender)
          // This prevents echo and ensures proper request-response flow
          let broadcastCount = 0;
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              const broadcastMessage = {
                type: "broadcast",
                message: data.message,
                sender: "peer",
                channel: channelName
              };
              console.log(`\n=== Broadcasting to peer #${broadcastCount} ===`);
              console.log(JSON.stringify(broadcastMessage, null, 2));
              client.send(JSON.stringify(broadcastMessage));
            }
          });

          if (broadcastCount === 0) {
            console.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
          } else {
            console.log(`✓ Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
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

          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<any>) {
      const meta = clientMeta.get(ws);

      monitors.delete(ws);

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

console.log(`WebSocket server running on port ${server.port}`);
console.log(`Web console available at http://localhost:${server.port}/console`);
