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

### computer-use 가 있는 에이전트라면 스스로 연결할 수 있다

플러그인을 띄우는 건 **사람 손이 필요한 유일한 단계**다. computer-use 권한이 있으면
에이전트가 직접 할 수 있다. 순서:

1. `list_figma_channels` 로 `hasFigma: true` 인 채널이 이미 있는지 본다. **있으면 여기서 끝** —
   괜히 앱을 건드리지 않는다.
2. 없으면 `open_application` 으로 Figma 데스크톱 앱을 띄운다(웹이 아니라 **데스크톱 앱**이어야
   개발 플러그인을 실행할 수 있다).
3. 대상 파일을 연다.
4. 메뉴에서 플러그인을 실행한다. 개발용으로 링크돼 있으면
   `Plugins → Development → Cursor MCP Plugin`.
5. 플러그인 창에 채널 ID 가 뜬다. `join_channel` 로 붙는다.
6. `get_document_info` 같은 가벼운 명령으로 살아 있는지 확인한다.

주의할 점:

- **Figma 는 브라우저가 아니라 네이티브 앱**이다. 브라우저 자동화 도구가 아니라 화면 제어
  도구를 써야 한다. computer-use 는 브라우저를 `read` 등급으로 제한하는 경우가 있는데,
  Figma 데스크톱 앱은 그 제한과 무관하다.
- **채널 ID 는 화면에서 읽어야 한다.** 플러그인 창에 표시된다. 스크린샷에서 읽거나,
  더 안전하게는 `list_figma_channels` 로 새로 생긴 채널을 찾는다(후자를 권한다 —
  화면에서 문자를 잘못 읽는 것보다 목록 비교가 확실하다).
- **플러그인 창을 닫으면 연결이 끊긴다.** 작업 내내 열어 둔다.

권한이 없다면 사용자에게 "플러그인을 실행해 주세요" 라고 요청하고, 실행되면
`list_figma_channels` 로 새 채널을 찾아 붙는다. 채널 ID 를 사용자가 불러 줄 필요는 없다.

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

## 2-1. 딸려 오는 스크립트

MCP 명령만으로 안 되는 것들 — 원근 워프, 이미지 규격 손질, 트리 전수 진단 — 은
`scripts/` 에 있다. **다시 짜지 말고 이걸 쓴다.**

| | 하는 일 |
|---|---|
| `figma-batch-client.mjs` | 릴레이에 명령을 순차 실행. 결과를 파일로 흘려 쓰고 **해시로 재개** |
| `figma-test-client.mjs` | 단일 명령. 큰 base64 는 `@file` 로 (argv 상한 회피) |
| `figma-text-sync.mjs` | 템플릿 행 ↔ 번역 행 텍스트 `pull`/`apply`. 복제본은 텍스트 순서가 1:1이라는 성질을 쓴다 |
| `figma-audit.mjs` | `leftovers`(숨은 잔존 문자열) · `hrows`(RTL 뒤집기 후보, 최상위만) |
| `warp-to-quad.py` | 직사각형 PNG → 기울어진 4점 슬롯 원근 워프 |
| `composite-watch.py` | 워치 액정에 화면 합성 (슬롯이 없는 목업용) |
| `image-prep.py` | `flatten`(알파 제거) · `check`(크기·모드) · `diff`(두 디렉토리 픽셀 대조) |

`image-prep.py flatten` 은 **App Store 업로드 전에 반드시** 돌린다. Figma export 는 RGBA 라
그대로 올리면 전부 `IMAGE_ALPHA_NOT_ALLOWED` 로 실패한다.

## 3. 부족하면 **직접 고쳐도 된다** (권장)

이 MCP는 우리가 쓰려고 우리가 들고 있는 도구다. 쓰다가 아래에 해당하면
**우회하지 말고 명령을 추가하거나 고친다.** 실제로 그렇게 늘려 왔다.

이 범위의 결함·누락 스펙은 별도 반복 승인 없이 focused branch에서 고치고, 실동작과
빌드를 검증한 뒤 PR을 만들 수 있다. 검증이 통과하고 PR 범위가 이 저장소 안에 한정되면
squash merge 후 branch를 정리한다. 외부 권한·자격 증명·데이터 접근 확대는 이 권한에
포함되지 않는다.

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
