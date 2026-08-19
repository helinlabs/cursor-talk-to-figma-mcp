# 다른 Mac에 그대로 보내는 단일 프롬프트

아래 코드 블록 전체를 새 PC의 에이전트에게 한 번에 전달합니다.

```text
이 Mac에 helinlabs의 Talk to Figma MCP를 끝까지 설치하고 실제 명령 호출까지 검증해 주세요.

정본 저장소는 https://github.com/helinlabs/cursor-talk-to-figma-mcp 입니다. 이 요청은 다음 범위를 명시적으로 승인합니다: 공식 Figma Desktop과 Bun이 없으면 공식 배포 경로로 설치, 저장소 clone/fetch, 의존성 설치, launchd relay 설치·재기동, 저장소의 개발용 Figma 플러그인 manifest import 및 실행, 로컬 MCP 설정, 검증용 editable draft 생성, 그리고 이 저장소 안에서 발견한 결함·누락 스펙을 고쳐 branch/commit/push/PR 생성 후 검증이 통과하면 squash merge하는 작업. 활성 시스템 안전정책상 작업 시점 확인이나 사람의 로그인 입력이 반드시 필요한 단계만 정확히 요청하고, 나머지는 중간 허락을 반복해서 묻지 마세요. 자격 증명이나 권한 범위를 임의로 확대하지 마세요.

완료 조건:
1. 저장소를 안정적인 개발 디렉터리에 clone합니다. 이미 있으면 사용자 변경을 보존하고 기본 branch를 안전하게 최신화합니다.
2. 저장소의 AGENTS.md, CLAUDE.md, README.md를 먼저 전부 읽습니다.
3. `bun install --frozen-lockfile`, `bun run build`, `./scripts/relayctl.sh install`, `./scripts/relayctl.sh status`를 실행합니다. 3055 포트와 `/plugin-version`, `/channels`를 확인합니다. `bun socket`을 서비스와 동시에 실행하지 마세요.
4. Figma 웹이 아니라 Figma Desktop을 사용합니다. 로그인은 이 Mac에 허가된 계정을 사용합니다. 다중 기기 세션 경고로 즉시 로그아웃되면 공유 계정을 고집하지 말고 이 Mac의 허가된 계정으로 전환합니다.
5. 기존 Cursor/Talk to Figma 개발 플러그인이 다른 경로를 가리키면 제거하거나 교체합니다. Figma의 Main menu → Plugins → Development → Import plugin from manifest…에서 clone한 저장소의 `src/cursor_mcp_plugin/manifest.json`을 불러옵니다.
6. 편집 가능한 Figma 파일에서 `Cursor MCP Plugin`을 실행해 3055 포트에 연결하고, 플러그인 창은 작업 중 계속 열어 둡니다. build hash와 channel ID를 확인합니다.
7. `/channels`에 Figma client와 현재 문서가 보이는지 확인한 뒤 `bun scripts/figma-test-client.mjs <channel> get_document_info '{}'`를 실행합니다. 이 실제 응답 없이는 성공으로 보고하지 마세요.
8. AI 클라이언트 MCP 설정은 npm 최신판이 아니라 clone한 로컬 `src/talk_to_figma_mcp/server.ts`를 Bun으로 실행하도록 절대 경로로 연결합니다. 기존 MCP 설정을 보존합니다. 클라이언트에서 `list_figma_channels` → `join_channel` → `get_document_info`까지 확인합니다.
9. 실패하면 relay → plugin → direct test client → MCP server → AI client 순서로 최초 실패 경계를 찾습니다. 플러그인을 다시 실행하면 channel ID가 바뀐다는 점, view-only 파일에서는 Development 플러그인을 실행할 수 없다는 점, 서버 변경은 MCP 재연결이 필요하고 plugin 변경은 Figma에서 재실행해야 하며 relay 변경은 `relayctl restart`가 필요하다는 점을 확인합니다.
10. 호출 중 필요한 Figma 기능이 없거나 반복 timeout·응답 상한·불필요한 다중 왕복이 드러나면 임시 우회로 끝내지 마세요. 기존 command union과 plugin dispatcher를 먼저 검색하고, 가능하면 기존 명령을 확장합니다. plugin 쪽을 먼저 구현해 `figma-test-client.mjs`로 실동작을 검증한 뒤 server schema/tool을 연결합니다. `bun run build`와 영향 범위 검증을 통과시키고, 새로 발견한 함정은 문서에 남깁니다. focused PR을 만들고 검증 후 squash merge합니다.
11. 최종 보고에는 설치 경로, Figma 계정 식별에 민감하지 않은 범위의 로그인 상태, relay 상태, plugin build hash, channel, 실제 `get_document_info` 결과, MCP client 연결 상태, 수정 commit/PR/merge 여부, 남은 제한을 포함합니다. 연결 완료 화면도 캡처합니다.

저장소에 `skills/setup-cursor-talk-to-figma/SKILL.md`가 있으면 그 스킬을 읽고 따르세요. 설정 과정에서 새로 배운 재현 가능한 문제와 해결책은 그 스킬 또는 관련 문서를 함께 개선하세요.
```
