# Changelog

## [0.34.2] - 2026-10-30

### Fixed

- **statusline 5h/7d 사용량이 갱신되지 않고 처음 받은 값에 멈춤.** 백그라운드 갱신이 자격 증명 JSON에서 `grep -o '"accessToken":"[^"]*"'`로 토큰을 뽑았는데, MCP 서버 OAuth 항목(`mcpOAuth.*.accessToken`, 빈 값일 수 있음)이 `claudeAiOauth`보다 앞에 있으면 두 줄이 잡혀 `Authorization` 헤더에 줄바꿈이 들어가고 curl이 `(43) bad argument`로 실패했다. 실패하면 옛 값을 유지하고 5분 뒤 재시도하므로 캐시가 처음 값에서 영원히 멈췄다(`N ago` 표시). 자격 증명을 JSON으로 파싱해 `claudeAiOauth.accessToken`만 쓰도록 바꿨다. 첫 실행 경로의 정규식도 같은 함수로 대체해 다른 토큰을 집을 여지를 없앴고, 토큰이 명령줄 인자로 노출되지 않는다.
- **Windows에서 statusline이 동작하지 않던 부분.**
  - 프로젝트 루트 탐색이 `"/"`에 닿을 때까지 올라가 Windows 드라이브 루트(`C:\`)에서 끝나지 않을 수 있었다 → 상위 경로가 자기 자신이면 멈춘다.
  - 사용량·새 버전 확인이 `sh -c` + `curl`·`grep`·`sed`·`date`·`mv`에 의존했다 → 같은 스크립트를 `--refresh usage|version` 자식 프로세스(현재 런타임의 `process.execPath`)로 띄워 Node `fetch`와 `fs`만으로 처리한다. 자식은 `windowsHide`로 창을 띄우지 않고, 실행 실패는 무시한다.

### Notes

- 사용자 조치 불필요. 멈춰 있던 사용량 캐시는 업데이트 후 첫 갱신 주기(60초)에 새 값으로 바뀐다.
- 캐시 파일 형식(`.usage_cache`·`.nexus_version_cache`·`.api_cost_cache`)은 그대로다.
- 영향 범위: `src/statusline/statusline.ts`(`scripts/statusline.mjs` 재빌드). 훅·스킬·에이전트·MCP 인터페이스 변경 없음.

## [0.34.1] - 2026-05-08

### Fixed

- **`UserPromptSubmit` 훅이 안내하는 스킬 이름에 플러그인 네임스페이스 누락 → `Skill(...)` 호출 실패.** 훅(`prompt-router.ts`)이 `[plan]`·`[auto-plan]`·`[run]` 태그를 받으면 모델에게 "Activate the nx-plan skill ..."처럼 단축명만 안내했고, Claude Code의 `Skill` 도구는 플러그인 스킬에 대해 풀 네임스페이스(`claude-nexus:nx-plan`)를 요구하므로 모델이 그대로 호출하면 `Unknown skill: nx-run`으로 실패했다. 안내 문구를 `claude-nexus:<skill>` 풀네임으로 교체하고 단축명 사용 시 실패한다는 가드 문구를 추가.

### Notes

- 사용자 조치 불필요. 플러그인 업데이트 후 다음 세션부터 자동 적용.
- 영향 범위: `src/hooks/prompt-router.ts`(`dist/hooks/prompt-router.js` 재빌드). 스킬 본문·에이전트·MCP 인터페이스·statusline 변경 없음.

## [0.34.0] - 2026-05-08

### Changed

- `@moreih29/nexus-core` **v0.20.1 → v0.21.0** 채택. 에이전트 명세 슬림화·Lead 재구조화·nx-run End-of-Cycle Review 신설·MCP 인터페이스 정비의 4개 축 변경을 흡수. 상세:
  - **(1) HOW/DO/CHECK 에이전트 8종 본문 4-axis evaluation thinking 슬림화.** architect / designer / engineer / postdoc / researcher / reviewer / tester / writer 각 HOW 섹션의 thinking 가이드를 4-axis evaluation 구조로 단일화. 각 에이전트의 분석 깊이는 유지되며 어휘·평가 축만 표준화됨. 영향받은 sync 산출물: `agents/{architect,designer,engineer,postdoc,researcher,reviewer,tester,writer}.md`.
  - **(2) Lead 본문 재구조화 — Behavior Principles 5개 신설.** ① Do not assert without evidence, ② Do not unconditionally accept, ③ Do not relay as-is, ④ Work scope direct, ⑤ Estimate in turns. Knowledge Layer는 `mission.md` + `conventions.md` 2-file 구조로 축소되어 Lead가 참조하는 컨텍스트 경계가 명확해짐. 영향받은 sync 산출물: `agents/lead.md`.
  - **(3) nx-run Step 4 End-of-Cycle Review 신설.** `[run]` cycle 종료 시 Lead가 원 요청 정합성·교차 task 일관성·암시된 후속 영역을 review하고 추가 task 등록 또는 close를 결정. iteration cap은 2회. 영향받은 sync 산출물: `skills/nx-run/SKILL.md`.
  - **(4) MCP 도구 인터페이스 정비.** `nx_history_search` 응답이 cell-level hits로 변경되었고 `scope` / `mode` / `group_by_cycle` 입력 필드가 추가됨. `nx_artifact_list` 도구가 신규 추가되어 저장된 아티팩트 목록 조회가 가능해짐. `nx_task_update`의 편집 가능 필드가 `status` / `acceptance` / `approach` / `risk` / `owner` / `result`로 제한됨(`title` / `context` / `deps`는 immutable). `TaskItem`에 `result { outcome, summary, artifacts, recorded_at }` 필드가 추가됨. `nx_task_close`에 incomplete guard와 `force` 옵션이 추가됨. id 계열 입력에 `z.coerce.number()`가 적용되어 문자열 id 전달 시에도 타입 오류 없이 처리됨.

### Removed

- **strategist 에이전트 제거.** upstream 명세 변경에 따라 `agents/strategist.md`가 삭제됨. upstream 결정 근거: "전략 결정은 사용자 영역이며 에이전트가 대리하지 않는다."

  ⚠️ **Consumer action required** — 기존 `[run]` cycle에서 strategist를 명시적으로 스폰하거나 Lead에게 strategist 위임을 요청했던 워크플로는 아래 3-방향으로 마이그레이션이 필요하다:

  1. **비즈니스/시장/포지셔닝 결정** → Lead에게 escalate하되, Lead는 Behavior Principle ②("Do not unconditionally accept — 사용자 의도·배경·제약을 먼저 확인")에 따라 결정을 사용자 영역으로 되돌린다. 전략 판단은 사용자가 직접 내리고 Lead는 그 결정을 실행 task로 분해한다.
  2. **기술 트레이드오프 분석** → **architect**에게 위임. architect는 설계 대안 비교·트레이드오프 평가·제약 도출을 담당한다.
  3. **연구·근거 평가** → **postdoc**에게 위임. postdoc는 문헌·선행 사례·근거의 비판적 검토를 담당한다.

### Notes

- 그 외 사용자 조치 불필요. Trigger 태그(`[plan]`, `[auto-plan]`, `[run]`)·MCP 서버 엔드포인트·hook·statusline은 모두 동일하며 플러그인 업데이트 시 새 spec이 자동 적용된다.
- 사용자가 인지할 동작 변화:
  - **(a) `[run]` cycle 종료 직전 Lead End-of-Cycle Review 추가.** cycle이 끝날 때 Lead가 원 요청 정합성과 교차 task 일관성을 점검하고, 암시된 후속 영역이 있으면 task를 추가 등록하거나 cycle을 close한다. iteration은 최대 2회로 제한됨.
  - **(b) Lead 응답 톤·평가 어휘 일관성 강화.** Lead 본문이 Behavior Principles 5개 구조로 재구조화되면서 근거 없는 단언·무조건적 수용·릴레이 응답이 명시적으로 억제되고, 평가 어휘가 4-axis 기준으로 표준화된다.
  - **(c) `nx_artifact_list`로 저장된 아티팩트 목록 조회 가능.** 이전에는 아티팩트 존재 여부를 `nx_history_search`로 간접 확인해야 했으나, 신규 `nx_artifact_list` 도구로 직접 조회할 수 있다.

## [0.33.1] - 2026-04-30

### Changed

- `@moreih29/nexus-core` **v0.20.0 → v0.20.1** 채택 (upstream PR #69, "chore(spec): tighten HOW collaboration in plan/auto-plan skills"). nx-plan / nx-auto-plan에서 Lead 단독 추론으로 권고안·결정을 만드는 경로를 spec 차원에서 차단. (1) **nx-auto-plan** — Core Rule이 3개 → 4개로 확장되며 **HOW/researcher/explore 협업이 Rule #1로 승격**(안건 도메인에 맞는 HOW 스폰이 default, 생략하려면 분석 텍스트에 사유 명시). 기존 "never stop"은 사용자 확인 대기 vs HOW 결과 대기로 분리되어 "HOW 결과를 기다리는 것은 멈춤이 아니다"가 명문화됨. (2) **nx-plan** — Supplementary Rule 1개 추가: `MUST gather multi-angle evidence before presenting a recommendation`. Identity·Core Rule은 불변. 영향받은 sync 산출물: `skills/nx-plan/SKILL.md`, `skills/nx-auto-plan/SKILL.md`. agents/* 및 nx-run skill, MCP 인터페이스 변경 없음.

### Notes

- 사용자 조치 불필요. Trigger 태그(`[plan]`, `[auto-plan]`)·MCP 도구·hook·statusline 모두 동일하며 플러그인 업데이트 시 새 spec이 자동 적용된다.
- 사용자가 인지 가능한 동작 변화: `[auto-plan]` 호출 시 안건마다 HOW 서브에이전트 스폰이 default가 되어 분석 깊이가 일관되게 강화된다 — 이전엔 Lead 단독 숙의로 빠르게 결정되던 안건도 도메인이 명확하면 HOW를 거친다. 사소한 안건이거나 `.nexus/memory`/`context`/`history`에 동일 분석이 있으면 Lead 단독 결정도 허용되며, 이때 사유가 분석 텍스트에 명시된다.

## [0.33.0] - 2026-04-29

### Added

- **Statusline에서 `CLAUDE_CONFIG_DIR` 환경변수 분리 동작 지원.** Claude Code 본체가 `CLAUDE_CONFIG_DIR`을 통해 다중 OAuth 계정을 분리 저장하는 알고리즘과 동일하게 statusline도 동작. 미설정 시 기본 `~/.claude`, 설정 시 ① 캐시 경로(`.usage_cache`, `.nexus_version_cache`, `.api_cost_cache`)를 해당 디렉토리로 이동, ② macOS keychain service 이름을 `Claude Code-credentials-<sha256(NFC(envValue))[:8]>` 형태로 본체와 일치시켜 본체가 저장한 토큰을 정확히 조회, ③ Linux/Windows의 `${CLAUDE_CONFIG_DIR}/.credentials.json` 평문 파일 경로도 자동 분기. 두 OAuth 계정을 번갈아 띄워도 5h/7d 사용량과 캐시가 섞이지 않는다.

- **API 모드(`ANTHROPIC_API_KEY` 설정) 사용자에게 오늘 비용 자동 표시.** 이전엔 `ANTHROPIC_ADMIN_KEY`를 별도 셋업한 소수만 활용 가능했고 그마저도 cost_report API의 query/response 변경으로 작동하지 않던 상태였음. 새 구현은 admin key 의존을 제거하고 로컬 jsonl 세션 로그(`${CLAUDE_CONFIG_DIR}/projects/<encoded-cwd>/<session>.jsonl`)를 직접 스캔해 오늘(UTC 자정 기준) 발생한 모든 assistant turn의 토큰을 모델별로 합산, Anthropic 공식 가격표 기반으로 USD 환산. statusline 라인 2에 `API $X.XX today` 형식으로 표시. 60s TTL 캐시 + mtime 필터로 매 렌더 비용은 < 100ms.

### Changed

- API 비용 표시 경로가 `cost_report` admin endpoint → 로컬 jsonl 스캔으로 전면 전환. `ANTHROPIC_ADMIN_KEY` 환경변수는 더 이상 사용되지 않는다(설정돼 있어도 무시됨, 에러 아님). 가격표는 `priceFor()` 함수 내부에 하드코딩되며 Opus 4 / 4.5+ / Sonnet 4.x / Haiku 4.5 / 구버전 deprecated 모델까지 패턴 매칭으로 18개 표준 모델 이름을 지원. cache_creation의 ephemeral 5m / 1h 분리 데이터를 우선 활용하고 없으면 안전한 5m 단가로 폴백.

### Fixed

- macOS keychain에서 Claude Code 본체가 저장한 토큰을 statusline이 못 찾던 문제. 이전엔 service 이름을 `"Claude Code-credentials"`로 하드코딩해서, `CLAUDE_CONFIG_DIR`로 띄운 세션의 OAuth 토큰 분리 저장(`-<hash>` suffix 형식)을 인식하지 못하고 항상 기본 계정 토큰만 읽었음. 본체와 동일 알고리즘으로 service 이름을 동적 생성해 정상화.

### Notes

- 사용자 조치 불필요. 플러그인 업데이트 후 다음 statusline 렌더부터 자동 적용.
- 가격표는 maintenance burden — Anthropic이 새 모델을 출시하면 패치 릴리즈가 필요하다. 알 수 없는 모델은 합산에서 silent skip되어 비용이 약간 under-report되지만 over-report되진 않는 설계. 출처: <https://platform.claude.com/docs/en/about-claude/pricing> (2026-04 검증).
- jsonl 포맷 의존: `~/.claude/projects/<encoded>/<session>.jsonl`은 Claude Code 내부 포맷이고 공식 stable API가 아니다. 본체가 포맷을 변경하면 statusline 비용 표시가 0이 되거나 누락될 수 있음. 다만 이 경로/포맷은 1년 이상 안정적이고 `ccusage` 등 광범위한 OSS 생태계가 의존하는 사실상 표준이라 위험은 낮다.
- 미반영 가격 변형: web search ($10/1k searches), code execution session-runtime, fast mode 6×, data residency 1.1×, batch 50% 할인 — Claude Code 일반 사용 패턴에선 발생하지 않는 케이스라 의도적으로 단순화.
- Windows에서 statusline 자체는 여전히 셸(`sh`/`curl`/`grep`/`sed`) 의존성이 남아 있어 WSL/Git Bash 없이는 동작하지 않는다(이번 릴리스 범위 밖).

## [0.32.1] - 2026-04-24

### Fixed

- 플러그인 루트 `settings.json`의 `agent` 값을 `"lead"` → `"claude-nexus:lead"`로 교정. Claude Code의 플러그인 서브에이전트 참조 규칙이 `<plugin-name>:<agent-name>` 네임스페이스 형식을 요구하므로, bare name은 조용히 무시되어 메인 스레드가 Lead 시스템 프롬프트·도구 제약·모델 설정을 적용받지 못하고 있었음. 네임스페이스 형식으로 교정되면서 플러그인 활성화 시 사용자 대면 메인 스레드가 **Lead 서브에이전트로 시작**되어 `agents/lead.md`의 전체 명세(Role, Default Stance, `[Pre-check]` opening scaffold, Evidence Requirement 등)가 주입됨. nexus-core 쪽 변경 없음 — canonical spec은 harness-agnostic이고, 네임스페이스 prefix는 이 플러그인(claude-nexus)의 `.claude-plugin/plugin.json` name 필드에 귀속되므로 소비자 플러그인 레벨에서 해결하는 것이 구조적으로 맞음.

### Notes

- 사용자 조치 불필요. 플러그인 업데이트만 받으면 다음 신규 세션부터 자동 적용.
- 기존 0.32.0 사용자는 업데이트 전까지 메인 스레드에 Lead 명세가 주입되지 않는 상태.
- `bun run sync` 재실행 시 `settings.json`이 덮어써지지 않음을 실측 확인(`wrote 0/13 files`, settings.json 무변동). nexus-sync의 스코프는 `agents/{id}.md`와 `skills/{id}/SKILL.md`에 한정.
- `test/e2e.sh`에 회귀 방지 가드 2개 추가. (1) `settings.json`의 `agent` 값이 `<plugin-name>:<id>` 네임스페이스 형식을 따르는지, (2) 참조하는 agent 파일이 실재하는지 검증. 플러그인 이름 변경·agent 파일 부재 같은 silent fail을 CI에서 조기 차단.

## [0.32.0] - 2026-04-23

### Changed

- `@moreih29/nexus-core` **v0.19.2 → v0.20.0** 채택. Lead spec과 nx-plan / nx-auto-plan / nx-run 스킬의 대규모 리팩터링 흡수. 핵심: (1) **Lead** — `[Pre-check]` opening scaffold 신규(의사결정·설계·반박 요청 시 응답이 점검 블록으로 시작, 복잡 요청은 축별 아이템 분해), Evidence requirement 신규(Lead 단독 추론 금지 — `researcher`/`explore`/`tester`/`.nexus` 출처 중 하나 필수), context·memory 능동 제안 정책 강화, 실행 흐름·사이클 보고·skill/MCP 카탈로그 섹션 제거(하네스·skill 본문과 중복). (2) **nx-plan** — Absolute Rules 3개(Lead 단독 결정 금지, 비교표 출력 후 강제 stop, 사용자 응답 보수적 해석). (3) **nx-auto-plan** — Absolute Rules 3개(자율 결정, 결정 유도 출력 금지, 안건 사이 멈춤 금지). (4) **nx-run** — 보고 형식 5항목 확장(변경사항·주요결정·다음단계·미해결질문·리스크). 영향받은 sync 산출물: `agents/lead.md`, `skills/nx-plan/SKILL.md`, `skills/nx-auto-plan/SKILL.md`, `skills/nx-run/SKILL.md`.

### Notes

- 사용자가 인지할 동작 변경: Lead의 substantive 응답이 `[Pre-check]` 블록으로 시작하는 것이 기본. 이전 버전과 응답 형식이 다르게 느껴질 수 있으나 정상 동작.
- nx-plan은 결정 시점에 반드시 멈춤(사용자 응답 없이 진행 안 함). nx-auto-plan은 안건 결정 사이에서 절대 멈추지 않음.
- Trigger 태그(`[plan]`, `[auto-plan]`, `[run]`)와 MCP 도구 인터페이스는 동일. 사용자 조치 불필요.

## [0.31.3] - 2026-04-22

### Changed

- `@moreih29/nexus-core` **v0.19.1 → v0.19.2** 채택 (upstream PR #65, "fix(plan): make resume macro explicit in planning skills"). `nx-plan` / `nx-auto-plan` Step 4.2에서 resume 분기가 자연어 "continue with the existing session"에서 하네스 구체 매크로 `SendMessage({ to: "<id>", message: "<resume prompt>" })`로 교체. Lead가 resume 경로를 고를 때 실제 호출 형태를 문서가 직접 보여주므로 `name` 혼동의 두 번째 경로도 차단됨. 영향받은 sync 산출물: `skills/nx-plan/SKILL.md`, `skills/nx-auto-plan/SKILL.md`.

## [0.31.2] - 2026-04-22

### Changed

- `@moreih29/nexus-core` **v0.19.0 → v0.19.1** 채택 (upstream PR #61, "fix(plan): require spawn agent id for resume records"). claude-nexus 이슈 #58 upstream 반영분. Lead가 종료된 서브에이전트를 resume할 때 `SendMessage({ to: <name> })`는 동작하지 않고 spawn 도구가 반환한 agent id(UUID) 필수라는 실측을 canonical 가이드가 명확히 반영. 영향받은 sync 산출물: `agents/lead.md`, `skills/nx-plan/SKILL.md`, `skills/nx-auto-plan/SKILL.md`. upstream PR #60(opencode skill frontmatter)·PR #62(codex nx launcher)는 다른 하네스 대상이라 본 플러그인에 영향 없음.

## [0.31.1] - 2026-04-22

### Fixed

- 플러그인 MCP 서버가 같은 이름(`nexus-core`)으로 **이중 등록**되어 `/mcp`에서 "Failed to reconnect to nexus-core"가 반복되던 문제. 원인은 플러그인 루트의 `.mcp.json`이 (1) 플러그인 manifest로 로드되는 경로와 (2) cwd가 플러그인 레포일 때 project-scoped MCP로도 로드되는 경로에서 동시에 읽혔기 때문. project-scoped 경로는 `${CLAUDE_PLUGIN_ROOT}` 변수를 치환하지 않아 `MODULE_NOT_FOUND`로 실패하며 재시도를 누적시킴. MCP 선언을 `.claude-plugin/plugin.json`의 인라인 `mcpServers` 필드로 이전하고 루트 `.mcp.json`을 제거해 이중 로드 경로 자체를 제거.

## [0.31.0] - 2026-04-22

### Changed

- `@moreih29/nexus-core` **v0.18.2 → v0.19.0** 채택 (upstream PR #56, "fix(plan): make nx_plan_decide decision-only"). MCP 번들(`dist/mcp/server.js`)과 sync 산출물(`skills/nx-plan/SKILL.md`, `skills/nx-auto-plan/SKILL.md`) Step 5 가이드가 새 계약에 맞춰 갱신됨.

### Breaking (upstream MCP contract passthrough)

- `nx_plan_decide` input 스키마에서 `how_agents` / `how_summary` / `how_agent_ids` 3개 필드 제거. 최종 결정 텍스트·상태만 저장하며 `issue.analysis`는 변형하지 않음.
- `issue.analysis`는 이제 **append-only** — HOW 기여 기록은 오직 `nx_plan_analysis_add(issue_id, role, agent_id?, summary)`를 통해 Step 4에서 쌓아야 함. Step 7 task 분해는 그 누적 기록을 참조.

### Consumer Action Required

- MCP 도구를 **직접** 호출해 `nx_plan_decide`에 `how_*` 필드를 넣고 있던 외부 소비자는 해당 필드를 제거해야 함. Lead 최종 synthesis는 `decision` 필드로만 전달.
- HOW 분석은 계속 `nx_plan_analysis_add`로 기록 유지. 사후에 HOW를 추가 실행해야 하면 재spawn/resume 후 analysis 엔트리를 새로 append.
- Nexus 스킬(`[plan]` / `[auto-plan]`)을 정상 경로로 사용하는 경우에는 사용자측 조치 없음 — 갱신된 SKILL 가이드가 자동으로 새 계약을 준수.

## [0.30.1] - 2026-04-22

### Fixed

- `bin` 이름을 `claude-nexus-statusline` → **`claude-nexus`**로 변경. v0.30.0 README의 `bunx claude-nexus-statusline`은 bunx/npx가 해당 이름의 npm 패키지를 찾으려 시도해 404로 깨지는 문제. package 이름과 bin 이름을 일치시켜 `bunx claude-nexus` · `bun add -g claude-nexus && claude-nexus` 양쪽 모두 동일 명령으로 동작.

### Consumer Action Required

v0.30.0에서 이미 `statusLine`을 설정한 사용자는 `~/.claude/settings.json`의 `statusLine.command`를 `claude-nexus-statusline` → `claude-nexus`(또는 `bunx claude-nexus`)로 수정.

## [0.30.0] - 2026-04-22

### Reset

v0.29.0 구현을 전면 폐기하고 nexus-core canonical 스펙에만 맞춰 재설계.

### Added

- nexus-core v0.18.2 canonical 에이전트 10종 (`nexus-sync` 생성)
- canonical 스킬 3종: `nx-auto-plan`, `nx-plan`, `nx-run`
- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` self-marketplace
- `nexus-core` MCP 서버 번들 (`dist/mcp/server.js`) — 마켓플레이스 설치 시 `node_modules` 불필요
- `SessionStart` 훅 — `.nexus/` 구조와 화이트리스트 `.gitignore` 보장
- `UserPromptSubmit` 훅 — 태그 6종 (`[plan]`·`[auto-plan]`·`[run]`·`[m]`·`[m:gc]`·`[d]`) 라우팅
- `settings.json`: `agent: "lead"` + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 활성
- `scripts/statusline.mjs` + `bin.claude-nexus-statusline` — 2줄 statusline CLI (v0.27.0에서 복구). 라인1: `◆Nexus vX.Y.Z` + 모델 + 프로젝트 + git 브랜치(staged/unstaged 카운트). 라인2: ctx + 5h + 7d 게이지(리셋 남은 시간, OAuth usage API, `~/.claude/.usage_cache`로 로컬 세션 간 캐시 공유). 사용자는 `bunx claude-nexus-statusline` 또는 전역 설치 후 `claude-nexus-statusline` 명령을 `~/.claude/settings.json`의 `statusLine.command`에 지정.

### Removed (consumer action required)

`@moreih29/nexus-core`에 canonical로 정의되지 않은 것은 모두 제거. v0.29.0 이하 사용자가 의존했다면 upstream 이슈로 제안해야 함.

- 스킬: `nx-init`, `nx-sync`, `nx-setup`
- 훅: `SubagentStart`, `SubagentStop`, `PostToolUse`(Edit 텔레메트리)
- 태그: `[sync]`, `[rule]`
- `VERSION` 파일 — 버전은 `package.json` + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` 3곳 동기로 단순화
- `CLAUDE.md`의 `<!-- NEXUS:START/END -->` 마커 관례
