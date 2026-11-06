# Claude Pin

> 프로젝트에 Claude 계정을 고정하세요.

프로젝트(레포)마다 Claude Code 계정을 하나씩 지정하는 Orca 플러그인입니다. 지정된 프로젝트의 워크트리에서 Orca가 Claude Code를 띄우면, 그 계정 폴더가 `CLAUDE_CONFIG_DIR`로 들어갑니다.

## 동작 방식

- **훅**: `agent.launch.before`에서 실행될 에이전트와 워크스페이스를 확인합니다. 에이전트가 `claude`이거나 `claude-agent-teams`이고 해당 프로젝트에 계정이 지정돼 있으면 `env.CLAUDE_CONFIG_DIR`를 추가합니다.
- **프로젝트 판단**: 워크스페이스 경로에서 `git rev-parse --git-common-dir`로 원본 레포를 찾습니다. 그래서 같은 레포에서 만든 워크트리는 모두 같은 계정을 씁니다. Git이 아닌 폴더 워크스페이스는 폴더 자체를 하나의 프로젝트로 봅니다.
- **계정 목록**: Orca 설정 → Accounts에 등록된 Claude 계정(`%APPDATA%\orca\claude-profiles\<id>\home`)을 그대로 씁니다. Orca가 이 폴더들에 plugins, skills, settings, 세션 기록(`projects/`)을 공유해 두기 때문에 계정이 바뀌어도 플러그인 구성과 세션 이어가기가 유지됩니다. 원하면 다른 `CLAUDE_CONFIG_DIR` 폴더를 직접 추가할 수도 있습니다.
- **Orca 전역 선택과의 관계**: Orca의 `claude` 셸 함수는 해당 창에 설정된 `CLAUDE_CONFIG_DIR`를 전역 선택보다 우선합니다. 그래서 지정된 프로젝트는 지정 계정으로, 지정되지 않은 프로젝트는 지금처럼 Orca 전역 선택 계정으로 실행됩니다.

## 설치 (개발 폴더로)

Orca **1.4.248 이상**이 필요합니다. 이 버전부터 `contributes.hooks`를 지원합니다.

```powershell
git clone https://github.com/tourbut/claude-pin
cd claude-pin
orca plugin test .          # 테스트
orca plugin dev load .      # 승인 지문을 출력하면 --approve <fingerprint>를 붙여 다시 실행
```

또는 Orca 설정 → Plugins → **Development folders…**에서 이 폴더를 추가하고 승인해도 됩니다.

## 사용법

1. 오른쪽 사이드바에서 **Claude Pin** 패널을 엽니다.
2. 프로젝트마다 계정을 고릅니다. `Orca 기본`을 고르면 지정이 해제됩니다.
3. 그다음 새로 여는 Claude 터미널부터 적용됩니다.

로그 확인: `orca plugin logs local.claude-pin`

동작 테스트(개발 폴더로 로드한 상태에서):

```powershell
orca plugin dev hook . agent.launch.before --data '{"agent":"claude","workspaceId":"<워크스페이스 id>","workspaceKind":"worktree","command":"claude","env":{}}'
```

## 설정

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `orcaDataDir` | 비움 | `claude-profiles`가 있는 Orca 데이터 폴더. 비워 두면 OS 기본 경로를 씁니다. |
| `agents` | `claude,claude-agent-teams` | 계정을 바꿔 줄 Orca 에이전트 id 목록 |
| `onMissingAccount` | `deny` | 지정된 계정 폴더가 사라졌을 때: 실행을 거부(`deny`)하거나 Orca 선택 계정으로 실행(`pass`) |

## 한계

- **복원·resume 세션**: Orca는 저장된 세션을 복원하거나 resume할 때 이 훅을 부르지 않습니다. 이때는 Orca 전역 선택 계정으로 실행됩니다. 세션 기록은 계정 간에 공유되므로 이어가기 자체는 됩니다.
- **네이티브 채팅**: 터미널이 아닌 Orca 채팅(structured session)은 훅을 거치지 않으므로 Orca 전역 선택을 따릅니다.
- **원격 워크스페이스**: SSH·WSL 워크스페이스는 경로가 이 PC에 없어서 건너뜁니다.
- **내부 구조 의존**: `claude-profiles` 폴더 구조와 워크스페이스 id 형식은 Orca 내부 사항이라 버전이 바뀌면 달라질 수 있습니다. 플러그인 API는 아직 Alpha 단계입니다.
- **사용자 전역 변수와 같은 폴더**: 직접 추가한 폴더가 시스템에 전역으로 설정한 `CLAUDE_CONFIG_DIR`와 같으면, Orca 셸 함수가 이를 "사용자 기본값"으로 보고 Orca 선택 계정을 대신 씁니다.

## 개발

```powershell
orca plugin types .     # .orca/types 생성 (타입 체크용)
orca plugin check .     # 검증 + 패널 렌더 확인
node --experimental-strip-types --test src/core/core.test.ts   # Orca 없이 핵심 로직만 테스트
```

MIT License
