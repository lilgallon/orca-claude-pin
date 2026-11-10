# Claude Pin design

Based on Orca 1.4.249, Claude Code 2.1.318, and macOS. Orca source paths refer to the `stablyai/orca` v1.4.249 tag.

## Goal

Once you set which Claude account each project uses, Claude Code started by Orca in that project always runs with that account. Mistakes such as company code going out through a personal account cannot be undone, so decisions follow this order of priority:

1. A pinned project **never silently runs with another account.** When in doubt, the launch is refused.
2. The behavior of unpinned projects does not change.
3. The user can tell which account currently applies, and where it does not apply.

## Key fact: the environment variable gets overwritten

The plugin API says `agent.launch.before` can add to `env`, but this does not work for the Claude account.

- The hook runs first (`src/main/ipc/pty/runtime/spawn.ts:25`), then `withClaudeProfileTerminalEnv` and `claudeAuth.envPatch` overwrite the same key (`runtime/spawn-preflight.ts:103,130`; window path `ipc/spawn-preflight.ts:119`, `ipc/spawn-env.ts:21`).
- The overwritten value equals `ORCA_CLAUDE_INJECTED_CONFIG_DIR`, so the shell's `claude` function treats it as Orca's value and re-reads `selected-host`.
- Plugins cannot set `ORCA_*` variables (`pluginHookEnvSchema` in `plugin-hook-payloads.ts`).

Measured: v0.1.0 set the account and logged a successful route, but the actual process's `CLAUDE_CONFIG_DIR` was the selected account. The environment variable survives only when Orca is on System default.

## Mechanism: command rewriting

When the command is a single command starting with `claude`, it becomes:

```sh
ORCA_CLAUDE_USER_CONFIG_DIR= CLAUDE_CONFIG_DIR='<account folder>' 'claude' …
```

- The shell function uses the value as-is when it differs from `ORCA_CLAUDE_INJECTED_CONFIG_DIR`. However, if it equals the folder the user exported themselves (`ORCA_CLAUDE_USER_CONFIG_DIR`), it falls back to the selected account, so that marker is blanked too. The `ORCA_*` ban applies only to the hook's `env` field, not to the command string.
- Orca's `withClaudeAgentViewPlugin` adds `--plugin-dir` to a `claude` following `NAME=value` tokens. A quoted `claude` is read as the same token.
- Quoting the word skips the user's alias. A compound alias such as `alias claude='nvm use && claude'` would end the assignment's effect at the first command and run the selected account. Function lookup is unaffected, so Orca's shell function is still reached. The cost is that aliases that only add flags no longer apply either.

Other commands (`sleep 1 && claude`, `claude --version && claude`, `/opt/claude`) assign first:

```sh
ORCA_CLAUDE_USER_CONFIG_DIR= && export CLAUDE_CONFIG_DIR='<account folder>' && <command>
```

The assignment applies to the whole line. Orca's parser cannot read `&&`, so `--plugin-dir` is dropped. Because the parts are joined with `&&` rather than `;`, shells that do not understand the assignment syntax (tcsh, etc.) stop with an error instead of falling back to another account.

Launches waiting for a setup script arrive as `bash -lc 'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"'`. The login shell reads the user's profile and may change the value, so the assignment moves inside `bash -lc`. In this case the hook cannot see the real command, so a check is added that stops in the shell if the real command contains `CLAUDE_CONFIG_DIR=`.

- `env` is set as well. Under System default this value survives, so Orca's trust record goes to the pinned account.
- If the pinned account is already the selected account, nothing changes. Switching right after launch could run with the new account, but the window is very short, so it is listed as a limitation in the README.
- If the command contains `CLAUDE_CONFIG_DIR=` itself, the later assignment wins, so it is refused. Content inside single quotes is excluded, since that is where Orca passes the prompt.
- The decision does not depend on the login shell. Orca picks the shell from `--shell`, the default terminal shell setting, then `SHELL`, so the plugin cannot know it; and since the forms above stop on failure in any shell, it is not needed.

`recognizeAgentProcessFromCommandLine` does not recognize the rewritten command, so the foreground process hint right after start and the `assertSafeAgentStartupCwd` check are skipped. This does not affect workspace launches; in measurements, `agentIdentity: claude` and prompt delivery worked normally.

### Approaches considered and rejected

| Approach | Why rejected |
| --- | --- |
| `env` only | Overwritten when an account is selected |
| `CLAUDE_CONFIG_DIR=… claude` | Loses to the user folder marker and to compound aliases, silently running the selected account |
| Always `VAR=…; claude` | Keeps aliases, but Orca cannot insert `--plugin-dir`, and in shells that do not understand the assignment, what follows `;` runs with the selected account |
| Prefix without assignment on compound commands | The second `claude` in `claude --version && claude` runs with the selected account |
| `\claude` | fish interprets `\c` as a control character |
| Require Orca's global selection to be System default | Would mean giving up Orca's account selection feature |
| Per-account `claude` shim scripts | Adds real binary lookup and file management |

## Preventing forged project detection

A `.git` file can point to any repository, so trusting it blindly would let a crafted folder obtain a pinned repository's account and folder trust. So `--git-dir` and `--git-common-dir` are read together and checked.

- Worktree: the repository's `worktrees/<name>/gitdir` must point back to this folder. Otherwise it is treated as unknown, and refused if anything is pinned. A worktree moved without repair gives the same result.
- Pointing directly at a `.git` directory: if the folder is not inside the repository folder, the folder itself is treated as the project. Submodules and `--separate-git-dir` behave the same.

## Folder trust

Orca adds the workspace to the trust list before launching, but the target is the final environment's `CLAUDE_CONFIG_DIR`, i.e. the selected account (`src/main/claude/claude-folder-trust-file.ts`). Pinning through the prefix would bring up Claude's trust prompt, whose default choice is "No, exit", halting automated launches.

So the hook writes the same record into the pinned account's `.claude.json`. Format and locking follow Orca's implementation.

- Keys: the NFC-normalized `resolve`d path and real path
- Lock: the same `<file>.lock` directory as Claude. If locked, briefly retries then gives up; never removes someone else's lock
- Write: re-reads inside the lock, writes a temp file with the same permissions, then renames. Removes the temp file on failure
- Scope: trust also applies to subfolders, so it is never written for the home folder, its parents, or the root
- State file: like Claude, a non-empty `.config.json` first, otherwise `.claude.json`. The sign-in display reads the same file
- Failure: only logged, the launch continues. The worst case is just a prompt.

The plugin cannot read Orca's `agentWorkspaceTrustEnabled` (`profile-state.db` has a private schema), so there is a separate `trustWorkspaces` setting.

## Decision order (`Router.decide`)

1. Pass if the agent is not targeted, there is no workspace, or nothing is pinned.
2. Find the path. Hook ids are `<repoId>::<path>` (folder repo instances add `::workspace:<uuid>`); `folder:<id>` is looked up in the `workspace.list` cache. Listing can take up to 5 seconds, so the hook waits only 800 ms.
3. Pass if all rows for the same path are on `ssh:` / `runtime:` hosts, the path is a WSL path, or it is not on this machine. The hook carries no host information, so local and remote using the same path cannot be told apart; in that case only pinned projects are refused.
4. Get the project key. If git cannot answer (`ENOENT`, timeout, `safe.directory`, worktree whose original repo cannot be found, etc.), it is not cached and is **refused**. v0.1.0 cached the path as the key in this case and missed the pin until restart. Only the `(or any of the parent directories)` message is accepted as "not a repository".
5. Pass if there is no pin.
6. `checkPin`: refuse if the account is missing or not signed in, or on Windows if the selected account is not the pinned account (or is unknown). The panel and status bar use the same check.
7. Refuse if an earlier plugin set a different folder.
8. Refuse if the command sets `CLAUDE_CONFIG_DIR` itself.
9. Pass if the pinned account is the selected account.
10. Refuse for Agent Teams: `orca claude-teams` re-injects the selected account's environment.
11. Otherwise route: `env` only on Windows, command rewriting elsewhere.

When `onPinFailure` is `pass`, refusals become passes.

## Failure handling

| Situation | Behavior |
| --- | --- |
| Hook exception, timeout, worker crash | Refused through the manifest's `onError: deny`. Unpinned projects are refused too, but the message names the plugin and disabling it recovers. Running on the wrong account cannot be undone. |
| Saving a pin fails | Applied in memory only after the save completes. An unsaved pin never shows in the panel and then vanishes on restart |
| Reading pin data fails | Does not fall back to empty values; retried on the next call. If it fails in the hook, it throws and is refused |
| Listener failure | Unhandled rejections kill the worker and Orca restarts it only 3 times in its lifetime, so all are caught and logged |
| Refusal reason over 500 characters | Orca ignores it and lets the launch through, so it is truncated |

`activate` waits for warm-up. This time counts against Orca's 10-second start limit rather than the first hook's 2 seconds, so even the first launch has warm caches. It stops waiting after 3 seconds, and activation succeeds even if warm-up fails.

## Per-account usage

Orca's bottom bar shows only the selected account, so when accounts are split per project, there is nowhere to see the pinned account's limits.

There is no per-account usage in the plugin API, RPC, or CLI (`src/main/rate-limits` only exports to the renderer), and Claude Code has no non-interactive command for it. So it uses the same method as Orca's `fetchClaudeOAuthUsage`.

- **Token**: on macOS, `security find-generic-password -s 'Claude Code-credentials-<first 8 chars of sha256(folder)>' -w`; if absent or on other OSes, `<folder>/.credentials.json`. The folder spelling at login determines the Keychain name, so the pinned path and the real path are tried in turn. It never falls back to the unsuffixed System default item.
- **Token handling**: it never leaves the function that reads it. It is not returned, logged, stored, or passed to the panel; errors keep only the status code and system error code.
- **Off by default**: the plugin approval screen only mentions full access, not that stored login tokens are read. So the panel has a switch with an explanation, and tokens are read only when the user turns it on.
- **No refresh**: refreshing a token causes rotation that can conflict with a running Claude, so that is left to Claude Code. Orca follows the same principle. A 401 is shown as "run once to refresh".
- **Network**: the worker has no `NODE_EXTRA_CA_CERTS`, so on corporate networks that inspect TLS it gets `SELF_SIGNED_CERT_IN_CHAIN` (measured). Orca goes through Chromium and uses the OS certificates; the plugin passes `tls.getCACertificates('bundled' + 'system')` with each request. Global settings are not changed. Networks requiring a proxy are not supported.
- **Request frequency**: started in the background only when the panel calls `state.get`. No polling. Results are kept 5 minutes per account (1 minute for the refresh button); on 429, nothing is asked until `retry-after` (seconds or a date, up to 24 hours); accounts are asked one at a time. If `showUsage` is turned off or an account removed mid-run, remaining accounts are not asked. When done it sends `state.changed`, and since the panel's subsequent `state.get` falls within the retention time, requests are not repeated.
- **What is shown**: only `five_hour`, `seven_day`, and `weekly_scoped` from `limits`. `spend` is excluded as it is overage or a team budget.
- **Not in the status bar**: no requests are made while the panel is closed, so the values would look stale.

The best alternative would be asking Orca for a per-account usage plugin API.

## Where the hook does not reach

`applyAgentLaunchPluginHook` only runs for launches that have `launchAgent` and `command` and are not restore or resume. Restore, resume, wake from sleep, hand-typed `claude`, terminal splits, `--command` with flags, and native chat cannot be pinned. Floating terminals have a null `workspaceId` and no working folder, so they cannot be judged. There is no other point where a plugin can change a terminal's environment.

Also, while `pluginHookWanted` is false (right after Orca starts, during plugin configuration changes), the chain does not run at all, so `onError: deny` does not apply either. This cannot be fully prevented without a fix on Orca's side, so the limitation is stated in the panel and README. The status bar tooltip mentions only restore/resume and hand-typed launches.

## What would be good to request from Orca

- `env` from `agent.launch.before` being kept for account variables too, or an official result field for setting the account
- Including in the hook and `workspace.changed` the same id and host information as `workspace.list`, plus the working folder
- Shipping plugin `.d.ts` files in the package (`orca plugin types` fails on 1.4.249)
- A plugin API for reading per-account usage

## Verification

- Unit: `orca plugin test .`
- Measured (macOS, Orca 1.4.249): pinned an account different from the selected one and checked the actual process environment and `/status`.

| Scenario | Result |
| --- | --- |
| `orca agent launch` in a pinned project | Pinned account, no trust prompt, `--plugin-dir` kept |
| `--prompt '/status'` | Pinned account, prompt delivered |
| `orca terminal create --command claude` | Pinned account |
| `claude` typed in a regular terminal | Selected account (known limitation) |
| Manual command suggested by the panel | Pinned account |
| Pinning the selected account | Command unchanged |
| Removing the pin | Selected account |
| Pinning a folder that is not signed in | Launch refused |
| Hook right after worker restart | OK, 0.28 s including the CLI round trip |
| Per-account usage from the real worker (TLS-inspecting network) | Two recently used accounts showed numbers, two with expired tokens showed the expiry notice |

Windows, Linux, SSH, Agent Teams, and refresh after token expiry were not measured.
