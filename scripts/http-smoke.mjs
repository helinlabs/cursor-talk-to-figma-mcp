import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 43000 + (process.pid % 1000);
const base = `http://127.0.0.1:${port}`;
const tempExportDir = mkdtempSync(join(tmpdir(), "talk-to-figma-http-smoke-"));
const child = spawn(process.execPath, ["dist/server.js", "--http", `--port=${port}`], {
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, FIGMA_EXPORT_DIR: tempExportDir },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not become healthy:\n${stderr}`);
}

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2025-03-26",
};

try {
  await waitForHealth();
  const fixtureName = "00000000-0000-4000-8000-000000000000.png";
  writeFileSync(join(tempExportDir, fixtureName), "png-smoke");
  const fixture = await fetch(`${base}/files/${fixtureName}`);
  assert.equal(fixture.status, 200);
  assert.equal(fixture.headers.get("content-type"), "image/png");
  assert.equal(await fixture.text(), "png-smoke");
  assert.equal((await fetch(`${base}/files/not-a-file`)).status, 404);

  const initialize = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "http-smoke", version: "1" },
      },
    }),
  });
  assert.equal(initialize.status, 200);
  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.match(await initialize.text(), /TalkToFigmaMCP/);

  const secondInitialize = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "http-smoke-2", version: "1" },
      },
    }),
  });
  assert.equal(secondInitialize.status, 200);
  const secondSessionId = secondInitialize.headers.get("mcp-session-id");
  assert.ok(secondSessionId);
  assert.notEqual(secondSessionId, sessionId);
  await secondInitialize.text();

  const sessionHeaders = { ...headers, "Mcp-Session-Id": sessionId };
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.ok(initialized.ok);

  const tools = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(tools.status, 200);
  const toolsBody = await tools.text();
  assert.match(toolsBody, /get_document_info/);
  assert.match(toolsBody, /export_node_as_image/);
  assert.match(toolsBody, /join_channel/);

  const blockedOutputPath = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "export_node_as_image", arguments: { nodeId: "1:2", outputPath: "/tmp/forbidden.png" } },
    }),
  });
  assert.equal(blockedOutputPath.status, 200);
  assert.match(await blockedOutputPath.text(), /outputPath is disabled in HTTP mode/);

  const closed = await fetch(`${base}/mcp`, { method: "DELETE", headers: sessionHeaders });
  assert.ok(closed.ok);
  const secondClosed = await fetch(`${base}/mcp`, {
    method: "DELETE",
    headers: { ...headers, "Mcp-Session-Id": secondSessionId },
  });
  assert.ok(secondClosed.ok);
  process.stdout.write("Streamable HTTP MCP smoke passed\n");
} finally {
  child.kill("SIGTERM");
  rmSync(tempExportDir, { recursive: true, force: true });
}
