# 다른 프로젝트에서 이 MCP 붙이기 · 그리고 직접 고치기

## 1. 붙이기 — 로컬 클론을 직접 가리킨다

npm 배포판(`bunx cursor-talk-to-figma-mcp@latest`)이 아니라 **로컬 소스를 가리켜야 한다.**
여기 있는 명령들(`mirror_horizontal`·`detach_instance`·`set_text_segments` 등)은 배포판에 없고,
무엇보다 **작업 중에 도구를 늘리려면 소스가 손에 있어야 한다**(3절).

작업할 프로젝트의 `.mcp.json`:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "/Users/<you>/.bun/bin/bun",
      "args": ["/절대경로/cursor-talk-to-figma-mcp/src/talk_to_figma_mcp/server.ts"]
    }
  }
}
```

또는 CLI로:

```bash
claude mcp add TalkToFigma -- ~/.bun/bin/bun /절대경로/cursor-talk-to-figma-mcp/src/talk_to_figma_mcp/server.ts
claude mcp list        # TalkToFigma ... ✔ Connected 확인
```

서버만으로는 아무것도 못 한다. **세 조각이 다 살아 있어야 한다.**

```
MCP 서버 ──(ws:3055)── 릴레이 ──(ws)── Figma 플러그인
```

| 조각 | 띄우는 법 | 확인 |
|---|---|---|
| 릴레이 | `./scripts/relayctl.sh install` (launchd, 로그인 시 자동) | `./scripts/relayctl.sh status` |
| 플러그인 | Figma → Plugins → Development → `src/cursor_mcp_plugin/manifest.json` 연결 후 실행 | 플러그인 창에 채널 ID |
| 채널 | `list_figma_channels` → `hasFigma: true` 인 것에 `join_channel` | |

**채널 ID는 플러그인을 다시 실행할 때마다 바뀐다.** 타임아웃이 나면 서버를 의심하기 전에
채널부터 다시 확인한다. 이게 이 스택에서 가장 흔한 헛수고다.

## 2. 고칠 때 무엇을 다시 띄워야 하나

| 고친 곳 | 반영 방법 |
|---|---|
| `src/cursor_mcp_plugin/code.js` (플러그인) | **Figma에서 플러그인을 다시 실행.** 채널 ID가 바뀐다 |
| `src/talk_to_figma_mcp/server.ts` (도구 등록) | `bun run build` 후 `/mcp` 재연결 또는 새 세션 |
| `src/socket.ts` (릴레이) | `./scripts/relayctl.sh restart` |

**세션 중에 도구를 추가했는데 새 세션을 열기 싫을 때** — 플러그인만 다시 실행하고
`scripts/figma-test-client.mjs <channel> <command> '<json>'` 로 릴레이에 직접 쏘면 된다.
MCP 서버 등록은 다음 세션부터 반영되지만, 플러그인 명령 자체는 즉시 쓸 수 있다.
명령이 많으면 `scripts/figma-batch-client.mjs`(결과를 파일로 흘려 쓰고 해시로 재개).

## 3. 부족하면 **직접 고쳐도 된다** (권장)

이 MCP는 우리가 쓰려고 우리가 들고 있는 도구다. 쓰다가 아래에 해당하면
**우회하지 말고 명령을 추가하거나 고친다.** 실제로 그렇게 늘려 왔다.

### 고쳐야 하는 신호

| 신호 | 예시 (실제로 겪은 것) |
|---|---|
| **스펙에 도달할 수 없다** | 인스턴스 내부를 못 고침 → `detach_instance` 추가 |
| | 구간별 폰트 크기를 못 읽고 씀 → `get/set_text_segments` |
| | 마스크 이미지를 꺼낼 수 없음 → `copy_image_fill`(hash 이관) |
| **탐색이 비효율적이다** | 트리를 여러 번 왕복 → `maxDepth`/`fields` 로 한 번에 |
| | 이름으로 노드를 못 찾음 → `scan_nodes_by_types` 로 기하 기반 검출 |
| **불안정하다** | 큰 base64 가 argv 상한에 걸림 → `@file` 파라미터 |
| | 배치가 셸 타임아웃에 죽음 → 결과를 흘려 쓰고 **해시로 재개** |
| | 응답이 토큰 상한 초과 → 파일로 받고 스크립트로 요약 |

### 고칠 때 지킬 것

1. **플러그인 쪽에 먼저 넣고 `figma-test-client.mjs` 로 실동작을 확인한 뒤** 서버에 등록한다.
   서버부터 만들면 새 세션을 열기 전까지 검증을 못 한다.
2. **왜 필요했는지를 주석에 남긴다.** "Figma 는 인스턴스 자식의 순서도 좌표도 못 바꾼다" 같은
   제약은 코드만 봐서는 안 드러나고, 다음 사람이 같은 벽에 다시 부딪힌다.
3. **되돌릴 수 있게 만든다.** `mirror_horizontal` 은 두 번 적용하면 원상복구다.
   덕분에 잘못 뒤집은 21개를 같은 목록으로 되돌릴 수 있었다.
4. **dry-run 을 기본값으로.** 쓰기 도구는 기본이 계획 출력, `--apply` 로만 실행.
5. 고쳤으면 [figma-automation-pitfalls.md](figma-automation-pitfalls.md) 에 한 줄 남긴다.

### 고치기 전에 확인할 것

**이미 있는지 먼저 본다.** `server.ts` 의 `FigmaCommand` union 과 `code.js` 의 dispatcher
`switch` 두 곳을 grep 하면 전체 목록이 나온다. 비슷한 게 있으면 새로 만들지 말고 옵션을 늘린다
(`clone_node` 에 `name`·`parentId` 를 붙인 것이 그 예다).
