# Claude Pin

> 프로젝트에 Claude 계정을 고정하세요.

Anthropic과 무관한 비공식 플러그인입니다. Anthropic이 만들거나 보증하지 않습니다. Claude와 Claude Code는 Anthropic의 상표입니다.

프로젝트(레포)마다 Claude Code 계정을 하나씩 지정하는 Orca 플러그인입니다. 지정된 프로젝트의 워크트리에서 Orca가 Claude Code를 새로 띄우면, Orca에서 전역으로 선택한 계정과 상관없이 그 계정으로 실행됩니다.

## 동작 방식

- **훅**: `agent.launch.before`에서 실행될 명령 앞에 계정 폴더를 붙입니다(`… CLAUDE_CONFIG_DIR='<계정 폴더>' 'claude' …`). Orca는 훅 다음에 환경 변수의 `CLAUDE_CONFIG_DIR`를 선택 계정으로 덮어쓰기 때문에, 환경 변수만으로는 지정이 적용되지 않습니다. 터미널에 이 긴 명령이 그대로 보입니다.
- **프로젝트 판단**: 워크스페이스 경로에서 `git rev-parse --git-common-dir`로 원본 레포를 찾습니다. 그래서 같은 레포에서 만든 워크트리는 모두 같은 계정을 씁니다. Git이 아닌 폴더 워크스페이스는 폴더 자체를 하나의 프로젝트로 봅니다.
- **계정 목록**: Orca 설정 → Accounts에 등록된 Claude 계정(`<Orca 데이터 폴더>/claude-profiles/<id>/home`)을 그대로 씁니다. 다른 `CLAUDE_CONFIG_DIR` 폴더를 직접 추가할 수도 있습니다.
- **폴더 신뢰**: Orca는 선택 계정에만 워크스페이스 신뢰를 기록합니다. 그대로 두면 지정 계정에서는 새 워크트리마다 Claude의 신뢰 프롬프트에 멈추므로, 이 플러그인이 지정 계정에 같은 기록을 남깁니다. 홈 폴더와 그 상위, 루트에는 기록하지 않습니다. `trustWorkspaces` 설정으로 끌 수 있습니다.
- **상태 표시줄**: 지금 보고 있는 프로젝트에 지정된 계정을 보여 줍니다.
- **계정별 사용량**: 기본으로 꺼져 있습니다. 패널의 "계정별 사용량 표시"를 켜면 패널이 열려 있을 때 계정마다 5시간·주간 사용량과 초기화 시각을 보여 줍니다. 프로젝트 카드에는 지정 계정의 사용량을 한 줄로 표시합니다.

자세한 근거는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 설치 (개발 폴더로)

Orca **1.4.248 이상**이 필요합니다. 이 버전부터 `contributes.hooks`를 지원합니다.

```sh
git clone https://github.com/tourbut/claude-pin
cd claude-pin
orca plugin test .          # 테스트
orca plugin dev load .      # 승인 지문을 출력하면 --approve <fingerprint>를 붙여 다시 실행
```

또는 Orca 설정 → Plugins → **Development folders…**에서 이 폴더를 추가하고 승인해도 됩니다.

제거: `orca plugin dev unload <폴더>`. 지정 정보는 `<Orca 데이터 폴더>/plugins-data/local.claude-pin/`에 남으니, 완전히 지우려면 Orca를 끈 뒤 이 폴더도 삭제하세요.

## 사용법

1. 오른쪽 사이드바에서 **Claude Pin** 패널을 엽니다.
2. 프로젝트마다 계정을 고릅니다. `Orca 기본`을 고르면 지정이 해제됩니다.
3. 그다음 새로 여는 Claude 터미널부터 적용됩니다.

터미널에서 Claude 안의 `/status`로 실제 계정을 확인할 수 있습니다.

로그 확인: `orca plugin logs local.claude-pin`

동작 테스트(개발 폴더로 로드한 상태에서):

```sh
orca plugin dev hook . agent.launch.before --data '{"agent":"claude","workspaceId":"<워크스페이스 id>","workspaceKind":"worktree","command":"claude","env":{}}'
```

## 설정

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `orcaDataDir` | 비움 | `claude-profiles`가 있는 Orca 데이터 폴더. 비워 두면 OS 기본 경로를 씁니다. |
| `agents` | `claude,claude-agent-teams` | 계정을 바꿔 줄 Orca 에이전트 id 목록 |
| `onPinFailure` | `deny` | 지정을 적용할 수 없을 때(계정 폴더 없음, 로그인 안 됨, 프로젝트 확인 실패, 아래 "그 밖의 한계"의 Agent Teams·셸·실행 명령·Windows): 실행을 거부(`deny`)하거나 Orca 선택 계정으로 실행(`pass`) |
| `showUsage` | `false` | 계정별 사용량을 표시합니다. 패널의 스위치와 같은 설정입니다. 꺼져 있으면 토큰을 읽거나 서버에 요청하지 않습니다. |
| `trustWorkspaces` | `true` | 지정 계정에 워크스페이스 신뢰를 기록합니다. Orca의 워크스페이스 신뢰를 껐다면 이것도 끄세요. 플러그인은 그 설정을 읽을 수 없습니다. |

## 지정이 적용되지 않는 경우

Orca가 훅을 부르지 않거나 플러그인이 끼어들 수 없는 실행입니다. 모두 Orca에서 선택한 계정으로 실행됩니다.

- **복원·resume·절전 복귀 세션**: 저장된 세션을 이어갈 때는 훅이 없습니다. 세션 기록은 계정 간에 공유되므로, 지정 계정으로 하던 대화가 다른 계정으로 이어질 수 있습니다.
- **직접 입력한 `claude`**: 일반 터미널에 입력한 `claude`, 터미널 분할, `--command 'claude --플래그'`, 폴더 워크스페이스의 `orca terminal create --command claude`. 필요하면 패널의 "터미널에서 직접 실행하려면" 명령을 쓰세요.
- **네이티브 채팅**: 터미널이 아닌 Orca 채팅은 훅을 거치지 않습니다.
- **플로팅 터미널**: 훅에 작업 폴더가 전달되지 않아 지정 프로젝트 폴더여도 알 수 없습니다.
- **Orca 계정 전환으로 다시 시작된 터미널**: 전환 정책에 따라 재시작되면 resume으로 실행되므로 지정이 풀립니다.
- **Orca가 플러그인을 다시 읽는 순간**: Orca 시작 직후와 플러그인 구성 변경 중에는 Orca가 훅을 건너뜁니다. `onError: deny`로도 막을 수 없습니다.
- **실행 직후 계정 전환**: 지정 계정이 곧 선택 계정이면 명령을 바꾸지 않으므로, 실행 후 셸이 `claude`를 부르기 전에 Orca 계정을 바꾸면 바뀐 계정으로 실행됩니다.

## 그 밖의 한계

아래에서 "거부"는 `onPinFailure`가 기본값 `deny`일 때입니다. `pass`면 Orca 선택 계정으로 실행됩니다.

- **Agent Teams**: `orca claude-teams`가 선택 계정의 환경을 직접 주입하므로 지정할 수 없습니다. 지정 계정이 선택 계정과 다르면 거부합니다.
- **셸**: zsh와 bash에서 실제로 시험했습니다. tcsh처럼 이 문법을 모르는 셸에서는 셸 오류로 실행이 멈추고, 다른 계정으로 넘어가지 않습니다. fish에서는 `claude`로 시작하지 않는 명령이 같은 오류로 멈춥니다.
- **`claude` alias**: 복합 alias가 지정을 끊지 않도록 alias를 건너뜁니다. 지정 프로젝트에서는 `alias claude='claude --플래그'` 같은 alias가 적용되지 않으니, Orca의 에이전트 명령 설정을 쓰세요.
- **에이전트 명령 설정**: `claude`로 시작하는 단일 명령이 아니면 Orca가 `--plugin-dir`를 넣지 못합니다. 명령이 `CLAUDE_CONFIG_DIR`를 직접 정하면 거부합니다. 래퍼 스크립트 안에서 바꾸는 것은 알 수 없습니다.
- **Windows**: 훅은 어떤 셸이 명령을 실행할지 알 수 없어서 명령을 바꾸지 않습니다. Orca 계정 선택이 System default일 때만 지정이 적용되고, 그 밖에는 거부합니다. Windows에서는 실제로 시험해 보지 않았습니다.
- **SSH·WSL 워크스페이스**: 건너뜁니다. 패널에도 나오지 않습니다. 같은 경로가 이 PC와 원격 호스트에 모두 있으면 어느 쪽 실행인지 알 수 없어, 지정된 프로젝트라면 거부합니다.
- **선택되지 않은 계정의 설정**: Orca는 선택된 계정 폴더만 settings와 훅을 갱신합니다. 지정 계정의 설정이 오래되었다면 Orca에서 그 계정을 한 번 선택하면 갱신됩니다.
- **Orca 사용량 표시**: Orca 하단의 사용량 막대는 선택 계정 기준입니다. 지정 계정의 사용량은 Claude Pin 패널에서 보세요.
- **계정별 사용량**: Orca처럼 각 계정의 저장된 토큰(macOS는 Keychain, 그 밖에는 `.credentials.json`)을 읽어 `api.anthropic.com/api/oauth/usage`에 요청합니다. 공개 API가 아니라서 언제든 바뀔 수 있습니다. 토큰은 이 요청에만 쓰고 저장하거나 기록하지 않습니다. 토큰을 갱신하지 않으므로, 한동안 쓰지 않은 계정은 그 계정으로 Claude를 한 번 실행할 때까지 만료로 표시됩니다. 패널이 열려 있는 동안 패널이 상태를 읽을 때만 요청하고(주기적으로 묻지 않음), 같은 계정은 5분(새로고침 버튼은 1분) 안에 다시 묻지 않습니다. 패널을 오래 열어 두면 수치가 낡을 수 있으니 "확인" 시각을 보세요. 프록시 설정은 읽지 않습니다.
- **로그인 상태**: macOS에서는 토큰이 Keychain에 있어 `.claude.json`의 계정 정보로만 판단합니다. 만료되거나 취소된 로그인은 구분하지 못합니다.
- **상태 표시줄**: Orca가 현재 워크스페이스의 id를 주지 않아 이름과 브랜치로 찾습니다. 같은 이름·브랜치의 워크스페이스끼리 지정이 다르면 표시하지 않습니다.
- **내부 구조 의존**: `claude-profiles` 폴더 구조, `selected-host` 파일, 워크스페이스 id 형식, 프리픽스를 허용하는 Orca의 명령 파서, 신뢰 기록 형식은 Orca·Claude Code 내부 사항이라 버전이 바뀌면 달라질 수 있습니다. 플러그인 API는 아직 Alpha 단계입니다. v1.4.249와 Claude Code 2.1.318에서 검증했습니다.

## 개발

```sh
orca plugin test .      # 전체 테스트
orca plugin check .     # 검증 + 패널 렌더 확인
node --experimental-strip-types --test src/core/core.test.ts   # Orca 없이 핵심 로직만 테스트
```

`orca plugin types .`는 Orca 1.4.249 패키지에 `.d.ts`가 빠져 있어 실패합니다. 타입 검사가 필요하면 Orca 저장소의 같은 버전 태그에서 `resources/plugins`의 타입 파일을 `.orca/types`로 복사하세요.

MIT License
