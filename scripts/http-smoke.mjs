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

  // 어느 문서에 말하는지는 호출이 스스로 말할 수 있어야 한다.
  //
  // 세션을 못 붙드는 호출자(넥서스가 터널 MCP 를 도구로 투영할 때가 그렇다 — 호출마다
  // 새 세션이다)는 join_channel 이 소용없다. 그때 `project` 가 없으면 디스크에 남은
  // 마지막 선택으로 조용히 흘러, **남이 마지막에 본 문서**를 읽는다(2026-09-01 실측).
  // 그래서 문서를 만지는 도구는 전부 이 인자를 노출해야 한다.
  const listed = JSON.parse(
    toolsBody.startsWith("event:")
      ? toolsBody.split("\n").find((line) => line.startsWith("data: ")).slice(6)
      : toolsBody,
  ).result.tools;
  const hasProject = (name) =>
    Boolean(listed.find((tool) => tool.name === name)?.inputSchema?.properties?.project);
  for (const name of ["get_document_info", "export_node_as_image", "run_figma_script", "set_text_content"]) {
    assert.ok(hasProject(name), `${name} 이 project 인자를 노출하지 않는다`);
  }
  // 프로젝트를 고르거나 릴레이 자체를 보는 도구에 이 인자를 얹으면 순환이다.
  for (const name of ["join_channel", "list_figma_projects", "list_figma_channels"]) {
    assert.ok(!hasProject(name), `${name} 은 project 인자를 받으면 안 된다`);
  }
  // use_figma_project 는 원래 자기 인자로 project 를 받는다(그게 이 도구의 일이다).
  // 래퍼가 그걸 선택 인자로 덮어써 「안 줘도 되는 것」으로 만들면 안 된다.
  const usePick = listed.find((tool) => tool.name === "use_figma_project");
  assert.ok(usePick?.inputSchema?.required?.includes("project"), "use_figma_project 의 project 가 필수가 아니다");
  // 면제 목록을 정확히 잠근다. 새 도구가 조용히 빠지면(래퍼를 안 타는 형태로 등록되면)
  // 그 도구만 남의 문서를 읽게 되는데, 그건 눈으로는 안 보인다.
  assert.ok(listed.length > 50, `도구가 ${listed.length}개뿐 — 목록을 못 읽었다`);
  const missing = listed.filter((tool) => !tool.inputSchema?.properties?.project).map((tool) => tool.name);
  assert.deepEqual(missing.sort(), [
    "cancel_bulk_operation",
    "get_bulk_operation",
    "get_figma_workload",
    "join_channel",
    "list_figma_channels",
    "list_figma_projects",
    "list_relay_errors",
  ], "project 를 안 받는 도구 목록이 바뀌었다 — 새 도구면 PROJECT_ARG_EXEMPT 를 확인할 것");

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
