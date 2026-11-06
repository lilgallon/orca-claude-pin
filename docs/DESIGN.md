# Claude Pin 설계

Orca 1.4.249, Claude Code 2.1.318, macOS 기준입니다. Orca 소스 경로는 `stablyai/orca` v1.4.249 태그 기준입니다.

## 목적

프로젝트마다 쓸 Claude 계정을 정해 두면, Orca가 그 프로젝트에서 띄우는 Claude Code가 항상 그 계정으로 실행되게 합니다. 회사 코드가 개인 계정으로 나가는 식의 실수는 되돌릴 수 없으므로 판단 기준은 다음 순서입니다.

1. 지정된 프로젝트가 **조용히 다른 계정으로 실행되지 않는다.** 확신할 수 없으면 실행을 거부합니다.
2. 지정되지 않은 프로젝트의 동작은 바꾸지 않는다.
3. 지금 어떤 계정이 적용되는지, 어디에 적용되지 않는지를 사용자가 알 수 있다.

## 핵심 사실: 환경 변수는 덮어써진다

플러그인 API는 `agent.launch.before`에서 `env`를 추가할 수 있다고 안내하지만, Claude 계정에는 통하지 않습니다.

- 훅이 먼저 실행되고(`src/main/ipc/pty/runtime/spawn.ts:25`), 그다음 `withClaudeProfileTerminalEnv`와 `claudeAuth.envPatch`가 같은 키를 덮어씁니다(`runtime/spawn-preflight.ts:103,130`, 창 경로는 `ipc/spawn-preflight.ts:119`, `ipc/spawn-env.ts:21`).
- 덮어쓴 값은 `ORCA_CLAUDE_INJECTED_CONFIG_DIR`와 같아서, 셸의 `claude` 함수는 이를 Orca 값으로 보고 `selected-host`를 다시 읽습니다.
- `ORCA_*` 변수는 플러그인이 설정할 수 없습니다(`plugin-hook-payloads.ts`의 `pluginHookEnvSchema`).

실측: v0.1.0은 계정을 지정하고 로그에 라우팅 성공을 남겼지만, 실제 프로세스의 `CLAUDE_CONFIG_DIR`는 선택 계정이었습니다. Orca가 System default일 때만 환경 변수가 살아남습니다.

## 메커니즘: 명령 재작성

명령이 `claude`로 시작하는 단일 명령이면 다음과 같이 바꿉니다.

```sh
ORCA_CLAUDE_USER_CONFIG_DIR= CLAUDE_CONFIG_DIR='<계정 폴더>' 'claude' …
```

- 셸 함수는 값이 `ORCA_CLAUDE_INJECTED_CONFIG_DIR`와 다르면 그대로 씁니다. 다만 사용자가 직접 export한 폴더(`ORCA_CLAUDE_USER_CONFIG_DIR`)와 같으면 선택 계정으로 돌아가므로 이 표시도 비웁니다. `ORCA_*` 금지는 훅의 `env` 필드에만 적용되고 명령 문자열에는 적용되지 않습니다.
- Orca의 `withClaudeAgentViewPlugin`은 `NAME=value` 토큰 뒤의 `claude`에 `--plugin-dir`를 붙입니다. 따옴표 안의 `claude`도 같은 토큰으로 읽습니다.
- 단어를 따옴표로 감싸면 사용자 alias를 건너뜁니다. `alias claude='nvm use && claude'` 같은 복합 alias는 대입의 효력을 첫 명령에서 끝내 선택 계정으로 실행시키기 때문입니다. 함수 탐색은 그대로이므로 Orca의 셸 함수는 거칩니다. 대가로 플래그만 붙이는 alias도 적용되지 않습니다.

그 밖의 명령(`sleep 1 && claude`, `claude --version && claude`, `/opt/claude`)은 먼저 대입합니다.

```sh
ORCA_CLAUDE_USER_CONFIG_DIR= && export CLAUDE_CONFIG_DIR='<계정 폴더>' && <명령>
```

대입이 줄 전체에 적용됩니다. Orca 파서가 `&&`를 읽지 못해 `--plugin-dir`는 빠집니다. `;` 대신 `&&`로 잇기 때문에 대입 구문을 모르는 셸(tcsh 등)은 오류로 멈추고, 다른 계정으로 넘어가지 않습니다.

설정 스크립트를 기다리는 실행은 `bash -lc 'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"'`로 들어옵니다. 로그인 셸이 사용자 프로필을 읽으며 값을 바꿀 수 있으므로 대입을 `bash -lc` 안쪽으로 옮깁니다. 이때 훅은 실제 명령을 볼 수 없어서, 실제 명령이 `CLAUDE_CONFIG_DIR=`를 포함하면 셸에서 멈추는 검사도 함께 넣습니다.

- `env`도 함께 설정합니다. System default에서는 이 값이 살아남아 Orca의 신뢰 기록이 지정 계정으로 갑니다.
- 지정 계정이 이미 선택 계정이면 아무것도 바꾸지 않습니다. 실행 직후 전환하면 바뀐 계정으로 실행될 수 있지만 창이 매우 짧아 README에 한계로 적습니다.
- 명령이 `CLAUDE_CONFIG_DIR=`를 직접 포함하면 나중 대입이 이기므로 거부합니다. 작은따옴표 안은 Orca가 프롬프트를 넘기는 자리라 제외합니다.
- 로그인 셸로 판단하지 않습니다. Orca는 `--shell`, 터미널 기본 셸 설정, `SHELL` 순으로 셸을 고르므로 플러그인이 알 수 없고, 위 형태가 어느 셸에서든 실패하면 멈추기 때문에 필요하지 않습니다.

`recognizeAgentProcessFromCommandLine`은 재작성된 명령을 인식하지 못해 시작 직후의 포그라운드 프로세스 힌트와 `assertSafeAgentStartupCwd` 검사가 빠집니다. 워크스페이스 실행에는 지장이 없고, 실측에서 `agentIdentity: claude`와 프롬프트 전달이 정상이었습니다.

### 검토 후 버린 방안

| 방안 | 버린 이유 |
| --- | --- |
| `env`만 사용 | 선택 계정이 있으면 덮어써짐 |
| `CLAUDE_CONFIG_DIR=… claude` | 사용자 폴더 표시, 복합 alias에 지면 조용히 선택 계정으로 실행됨 |
| 항상 `VAR=…; claude` | alias는 유지되지만 Orca가 `--plugin-dir`를 넣지 못하고, 대입을 모르는 셸에서 `;` 뒤가 선택 계정으로 실행됨 |
| 프리픽스를 대입 없이 복합 명령에 사용 | `claude --version && claude`의 두 번째가 선택 계정으로 실행됨 |
| `\claude` | fish에서 `\c`가 제어 문자로 해석됨 |
| Orca 전역을 System default로 요구 | Orca의 계정 선택 기능을 포기해야 함 |
| 계정별 `claude` 심 스크립트 | 실제 바이너리 탐색과 파일 관리가 늘어남 |

## 폴더 신뢰

Orca는 실행 전에 워크스페이스를 신뢰 목록에 올리지만, 대상은 최종 환경의 `CLAUDE_CONFIG_DIR`, 즉 선택 계정입니다(`src/main/claude/claude-folder-trust-file.ts`). 프리픽스로 지정하면 Claude의 신뢰 프롬프트가 뜨고 기본 선택이 "No, exit"이어서 자동화 실행이 멈춥니다.

그래서 훅에서 지정 계정의 `.claude.json`에 같은 기록을 남깁니다. 형식과 잠금은 Orca 구현을 따릅니다.

- 키: `resolve`한 경로와 실제 경로의 NFC 정규화 값
- 잠금: Claude와 같은 `<파일>.lock` 디렉터리. 잠겨 있으면 짧게 재시도한 뒤 포기하고, 남의 잠금은 지우지 않음
- 쓰기: 잠금 안에서 다시 읽고, 같은 권한의 임시 파일을 쓴 뒤 rename. 실패하면 임시 파일을 지움
- 범위: 신뢰는 하위 폴더에도 적용되므로 홈 폴더와 그 상위, 루트에는 기록하지 않음
- 상태 파일: Claude처럼 비어 있지 않은 `.config.json`을 먼저, 없으면 `.claude.json`을 씀. 로그인 표시도 같은 파일을 읽음
- 실패: 로그만 남기고 실행을 계속합니다. 최악의 경우 프롬프트가 뜰 뿐입니다.

플러그인은 Orca의 `agentWorkspaceTrustEnabled`를 읽을 수 없으므로(`profile-state.db`는 비공개 스키마), `trustWorkspaces` 설정을 따로 둡니다.

## 판단 순서 (`Router.decide`)

1. 대상 에이전트가 아니거나, 워크스페이스가 없거나, 지정이 하나도 없으면 통과합니다.
2. 경로를 찾습니다. 훅 id는 `<repoId>::<path>`(폴더 레포 인스턴스는 뒤에 `::workspace:<uuid>`)이고, `folder:<id>`는 `workspace.list` 캐시에서 찾습니다. 목록 조회는 5초까지 걸릴 수 있어 훅 안에서는 800ms만 기다립니다.
3. 같은 경로의 행이 모두 `ssh:`·`runtime:` 호스트이거나 WSL 경로이거나 이 PC에 없는 경로면 통과합니다. 훅에 호스트 정보가 없어서 로컬과 원격이 같은 경로를 쓰면 구분할 수 없습니다. 이때는 지정된 프로젝트만 거부합니다.
4. 프로젝트 키를 구합니다. git이 답하지 못하면(`ENOENT`, 시간 초과, `safe.directory`, 원본 레포를 찾지 못하는 워크트리 등) 캐시하지 않고 **거부**합니다. v0.1.0은 이때 경로를 키로 캐시해서 재시작 전까지 지정을 놓쳤습니다. "저장소가 아님"으로 인정하는 것은 `(or any of the parent directories)` 문구뿐입니다.
5. 지정이 없으면 통과합니다.
6. `checkPin`: 계정이 없거나 로그인되어 있지 않거나, Windows에서 선택 계정이 지정 계정이 아니면(또는 알 수 없으면) 거부합니다. 패널과 상태 표시줄도 같은 검사를 씁니다.
7. 앞선 플러그인이 다른 폴더를 정했으면 거부합니다.
8. 명령이 `CLAUDE_CONFIG_DIR`를 직접 정하면 거부합니다.
9. 지정 계정이 선택 계정이면 통과합니다.
10. Agent Teams면 거부합니다. `orca claude-teams`가 선택 계정의 환경을 다시 주입합니다.
11. 그 밖에는 라우팅합니다. Windows는 `env`만, 나머지는 명령 재작성입니다.

거부는 `onPinFailure`가 `pass`면 통과로 바뀝니다.

## 실패 처리

| 상황 | 동작 |
| --- | --- |
| 훅 예외·시간 초과·워커 크래시 | 매니페스트 `onError: deny`로 거부. 지정 없는 프로젝트도 함께 거부되지만, 메시지에 플러그인 이름이 나오고 비활성화로 복구할 수 있습니다. 잘못된 계정 실행은 되돌릴 수 없습니다. |
| 지정 저장 실패 | 저장이 끝난 뒤에만 메모리에 반영. 저장되지 않은 지정이 패널에 보였다가 재시작 때 사라지지 않음 |
| 지정 정보 읽기 실패 | 빈 값으로 넘어가지 않고 다음 호출에서 재시도. 훅에서 실패하면 예외로 거부 |
| 리스너 실패 | 처리되지 않은 rejection은 워커를 죽이고 Orca는 생애 3회만 재시작하므로 모두 잡아서 로그로 남김 |
| 거부 사유 500자 초과 | Orca가 무시하고 통과시키므로 잘라서 보냄 |

`activate`에서 준비 작업을 기다립니다. 이 시간은 첫 훅의 2초가 아니라 Orca의 10초 시작 제한에 포함되므로 첫 실행도 캐시가 데워진 상태입니다. 3초가 넘으면 기다림을 그만두고, 실패해도 활성화는 성공시킵니다.

## 계정별 사용량

Orca 하단 막대는 선택 계정만 보여 주므로, 프로젝트마다 계정을 나눠 쓰면 지정 계정의 한도를 볼 곳이 없습니다.

플러그인 API, RPC, CLI 어디에도 계정별 사용량이 없고(`src/main/rate-limits`는 렌더러로만 내보냄), Claude Code에도 비대화형 명령이 없습니다. 그래서 Orca의 `fetchClaudeOAuthUsage`와 같은 방식을 씁니다.

- **토큰**: macOS는 `security find-generic-password -s 'Claude Code-credentials-<sha256(폴더) 앞 8자>' -w`, 없거나 다른 OS면 `<폴더>/.credentials.json`. 로그인할 때의 폴더 철자가 Keychain 이름을 정하므로 지정 경로와 실제 경로를 차례로 시도합니다. 접미사 없는 System default 항목으로는 넘어가지 않습니다.
- **토큰 취급**: 읽은 함수 밖으로 나가지 않습니다. 반환, 로그, 저장, 패널 전달이 없고 오류는 상태 코드와 시스템 오류 코드만 남깁니다. `showUsage`로 끌 수 있습니다.
- **갱신하지 않음**: 토큰 갱신은 회전을 일으켜 실행 중인 Claude와 충돌할 수 있어 Claude Code에 맡깁니다. Orca도 같은 원칙입니다. 401은 "한 번 실행하면 갱신"으로 표시합니다.
- **네트워크**: 워커에는 `NODE_EXTRA_CA_CERTS`가 없어 TLS를 검사하는 회사망에서 `SELF_SIGNED_CERT_IN_CHAIN`이 납니다(실측). Orca는 Chromium을 거치므로 OS 인증서를 쓰고, 플러그인은 요청마다 `tls.getCACertificates('bundled' + 'system')`을 넘깁니다. 전역 설정은 바꾸지 않습니다. 프록시를 요구하는 망은 지원하지 않습니다.
- **요청 빈도**: 패널이 `state.get`을 부를 때만 백그라운드로 시작합니다. 폴링하지 않습니다. 계정별 5분 유지, 새로고침 버튼은 1분, 429는 `retry-after`(초 또는 날짜, 최대 24시간)까지 묻지 않고, 계정을 차례로 묻습니다. 진행 중에 `showUsage`를 끄거나 계정을 지우면 남은 계정은 묻지 않습니다. 끝나면 `state.changed`를 보내고, 패널이 다시 `state.get`을 불러도 유지 시간 안이라 요청이 반복되지 않습니다.
- **표시 범위**: `five_hour`, `seven_day`, `limits`의 `weekly_scoped`만 씁니다. `spend`는 초과분이나 팀 예산이라 제외합니다.
- **상태 표시줄에는 넣지 않음**: 패널이 닫혀 있으면 요청하지 않으므로 값이 낡아 보입니다.

대안으로 Orca에 계정별 사용량 플러그인 API를 요청하는 것이 가장 좋습니다.

## 훅이 닿지 않는 곳

`applyAgentLaunchPluginHook`은 `launchAgent`와 `command`가 있고 restore·resume이 아닌 실행에만 동작합니다. 복원·resume·절전 복귀, 직접 입력한 `claude`, 터미널 분할, 플래그가 붙은 `--command`, 네이티브 채팅은 지정할 수 없습니다. 플로팅 터미널은 `workspaceId`가 null이고 작업 폴더도 전달되지 않아 판단할 수 없습니다. 플러그인이 터미널 환경을 바꿀 다른 지점은 없습니다.

또한 `pluginHookWanted`가 false인 동안(Orca 시작 직후, 플러그인 구성 변경 중)에는 체인 자체가 실행되지 않아 `onError: deny`도 적용되지 않습니다. Orca 쪽 수정 없이는 완전히 막을 수 없으므로 패널과 README에 한계를 명시합니다. 상태 표시줄 툴팁은 복원·resume과 직접 입력만 언급합니다.

## Orca에 요청하면 좋은 것

- `agent.launch.before`의 `env`가 계정 변수에서도 유지되거나, 계정을 지정하는 공식 결과 필드
- 훅과 `workspace.changed`에 `workspace.list`와 같은 id·호스트 정보와 작업 폴더 포함
- 패키지에 플러그인 `.d.ts` 포함 (`orca plugin types`가 1.4.249에서 실패)
- 계정별 사용량을 읽는 플러그인 API

## 검증

- 단위: `orca plugin test .`
- 실측(macOS, Orca 1.4.249): 선택 계정과 다른 계정을 지정해 실제 프로세스 환경과 `/status`를 확인했습니다.

| 시나리오 | 결과 |
| --- | --- |
| 지정 프로젝트의 `orca agent launch` | 지정 계정, 신뢰 프롬프트 없음, `--plugin-dir` 유지 |
| `--prompt '/status'` | 지정 계정, 프롬프트 전달됨 |
| `orca terminal create --command claude` | 지정 계정 |
| 일반 터미널에 입력한 `claude` | 선택 계정 (알려진 한계) |
| 패널이 안내하는 수동 명령 | 지정 계정 |
| 선택 계정을 지정 | 명령 변경 없음 |
| 지정 해제 | 선택 계정 |
| 로그인 안 된 폴더를 지정 | 실행 거부 |
| 워커 재시작 직후 훅 | 정상, CLI 왕복 포함 0.28초 |
| 실제 워커에서 계정별 사용량 조회 (TLS 검사 망) | 최근 쓴 계정 2개는 수치 표시, 토큰이 만료된 2개는 만료 안내 |

Windows, Linux, SSH, Agent Teams, 토큰 만료 후 갱신은 실측하지 않았습니다.
