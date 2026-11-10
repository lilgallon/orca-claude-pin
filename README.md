# Claude Pin

> Pin a Claude account to each project.

Unofficial plugin, not affiliated with Anthropic. It is not made or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

This is a fork of [tourbut/claude-pin](https://github.com/tourbut/claude-pin), with the documentation translated to English.

An Orca plugin that assigns one Claude Code account to each project (repository). When Orca starts a new Claude Code in a worktree of a pinned project, it runs with that account, regardless of the account selected globally in Orca.

## How it works

- **Hook**: in `agent.launch.before`, the account folder is prepended to the command about to run (`… CLAUDE_CONFIG_DIR='<account folder>' 'claude' …`). After the hook, Orca overwrites `CLAUDE_CONFIG_DIR` in the environment with the selected account, so the environment variable alone cannot apply the pin. This long command is visible as-is in the terminal.
- **Project detection**: the original repository is found from the workspace path with `git rev-parse --git-common-dir`. All worktrees created from the same repository therefore use the same account. A non-Git folder workspace counts as its own project.
- **Account list**: the Claude accounts registered in Orca Settings → Accounts (`<Orca data folder>/claude-profiles/<id>/home`) are used as-is. You can also add other `CLAUDE_CONFIG_DIR` folders by hand.
- **Folder trust**: Orca records workspace trust only in the selected account. Left alone, the pinned account would stop at Claude's trust prompt for every new worktree, so this plugin writes the same record into the pinned account. It never writes it for the home folder, its parents, or the root. It can be turned off with the `trustWorkspaces` setting.
- **Status bar**: shows the account pinned to the project you are currently looking at.
- **Languages**: English and French, following Orca's language by default (see the `language` setting).
- **Per-account usage**: off by default. When you turn on "Show each account's usage" in the panel, it shows each account's 5-hour and weekly usage and reset times while the panel is open. Project cards show the pinned account's usage on one line.

The detailed rationale is in [docs/DESIGN.md](docs/DESIGN.md).

## Installation (as a development folder)

Requires Orca **1.4.248 or later**, the first version that supports `contributes.hooks`.

```sh
git clone https://github.com/lilgallon/orca-claude-pin
cd orca-claude-pin
orca plugin test .          # tests
orca plugin dev load .      # if it prints an approval fingerprint, run again with --approve <fingerprint>
```

Alternatively, add this folder in Orca Settings → Plugins → **Development folders…** and approve it.

Uninstall: `orca plugin dev unload <folder>`. Pin data stays in `<Orca data folder>/plugins-data/local.claude-pin/`; to remove everything, quit Orca and delete that folder too.

## Usage

1. Open the **Claude Pin** panel in the right sidebar.
2. Pick an account for each project. Choosing `Orca default` removes the pin.
3. It applies from the next Claude terminal you open.

Inside Claude, `/status` in the terminal shows the actual account.

Logs: `orca plugin logs local.claude-pin`

Behavior test (with the plugin loaded as a development folder):

```sh
orca plugin dev hook . agent.launch.before --data '{"agent":"claude","workspaceId":"<workspace id>","workspaceKind":"worktree","command":"claude","env":{}}'
```

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `orcaDataDir` | empty | The Orca data folder containing `claude-profiles`. When empty, the OS default path is used. |
| `agents` | `claude,claude-agent-teams` | Orca agent ids whose account is switched |
| `onPinFailure` | `deny` | When a pin cannot be applied (account folder missing, not signed in, project could not be determined, or Agent Teams / shell / launch command / Windows from "Other limitations" below): refuse the launch (`deny`) or run it with Orca's selected account (`pass`) |
| `showUsage` | `false` | Shows each account's usage. Same setting as the switch in the panel. When off, no token is read and no request is sent. |
| `trustWorkspaces` | `true` | Records workspace trust in the pinned account. If you turned off Orca's workspace trust, turn this off too; the plugin cannot read that setting. |
| `language` | `auto` | Language of the panel, the status bar and launch refusals: `en` (English) or `fr` (French). `auto` follows Orca's language, which only the panel can read: until the panel has been opened once, the system language is used, then English. |

## When the pin does not apply

These are launches where Orca does not call the hook or the plugin cannot step in. They all run with the account selected in Orca.

- **Restored, resumed, or wake-from-sleep sessions**: there is no hook when a saved session is continued. Session history is shared between accounts, so a conversation started on the pinned account may continue on another account.
- **`claude` typed by hand**: `claude` typed in a regular terminal, terminal splits, `--command 'claude --flag'`, and `orca terminal create --command claude` in a folder workspace. If needed, use the command under "To run it directly in a terminal" in the panel.
- **Native chat**: Orca's non-terminal chat does not go through the hook.
- **Floating terminals**: the hook receives no working folder, so it cannot tell even when it is in a pinned project folder.
- **Terminals restarted by an Orca account switch**: depending on the switch policy, the restart runs as a resume, so the pin is lost.
- **While Orca reloads plugins**: right after Orca starts and while the plugin configuration changes, Orca skips hooks. `onError: deny` cannot prevent this either.
- **Account switch right after launch**: when the pinned account is already the selected account, the command is left unchanged, so if you switch Orca's account after launch but before the shell calls `claude`, it runs with the new account.

## Other limitations

Below, "refuse" applies when `onPinFailure` is the default `deny`. With `pass`, the launch runs with Orca's selected account.

- **Agent Teams**: `orca claude-teams` injects the selected account's environment directly, so it cannot be pinned. It is refused when the pinned account differs from the selected account.
- **Shells**: actually tested with zsh and bash. In shells that do not understand this syntax, such as tcsh, the launch stops with a shell error and does not fall back to another account. In fish, commands not starting with `claude` stop with the same error.
- **`claude` alias**: aliases are skipped so that a compound alias cannot break the pin. In pinned projects, an alias such as `alias claude='claude --flag'` does not apply; use Orca's agent command setting instead.
- **Agent command setting**: unless it is a single command starting with `claude`, Orca cannot insert `--plugin-dir`. If the command sets `CLAUDE_CONFIG_DIR` itself, it is refused. Changes made inside a wrapper script cannot be detected.
- **Windows**: the hook cannot know which shell will run the command, so the command is not changed. The pin applies only when Orca's account selection is System default; otherwise it is refused. Not actually tested on Windows.
- **SSH and WSL workspaces**: skipped, and not shown in the panel. If the same path exists both on this machine and on a remote host, it cannot tell which one is launching, so it refuses if the project is pinned.
- **Settings of non-selected accounts**: Orca updates settings and hooks only in the selected account folder. If a pinned account's settings are outdated, selecting that account once in Orca refreshes them.
- **Orca usage display**: Orca's bottom usage bar is based on the selected account. See the pinned account's usage in the Claude Pin panel.
- **Per-account usage**: like Orca, it reads each account's stored token (Keychain on macOS, `.credentials.json` elsewhere) and requests `api.anthropic.com/api/oauth/usage`. This is not a public API and may change at any time. The token is used only for this request and is never stored or logged. The token is not refreshed, so an account unused for a while shows as expired until you run Claude with that account once. Requests happen only while the panel is open and reads its state (no periodic polling), and the same account is not asked again within 5 minutes (1 minute for the refresh button). If the panel stays open for a long time the numbers can go stale, so check the "checked" time. Proxy settings are not read.
- **Sign-in status**: on macOS the token is in the Keychain, so sign-in is judged only from the account info in `.claude.json`. Expired or revoked logins cannot be distinguished.
- **Status bar**: Orca does not provide the current workspace's id, so it is matched by name and branch. If workspaces with the same name and branch have different pins, nothing is shown.
- **Dependence on internals**: the `claude-profiles` folder layout, the `selected-host` file, the workspace id format, Orca's command parser accepting prefixes, and the trust record format are Orca and Claude Code internals and may change between versions. The plugin API is still in Alpha. Verified with v1.4.249 and Claude Code 2.1.318.

## Development

```sh
orca plugin test .      # all tests
orca plugin check .     # validation + panel render check
node --experimental-strip-types --test src/core/core.test.ts   # core logic only, without Orca
```

`orca plugin types .` fails because the Orca 1.4.249 package is missing its `.d.ts` files. If you need type checking, copy the type files from `resources/plugins` at the same version tag of the Orca repository into `.orca/types`.

MIT License
