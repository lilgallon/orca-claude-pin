// Plain Node tests for the routing logic: `orca plugin test .` or
// `node --experimental-strip-types --test src/core/core.test.ts`.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import type https from 'node:https'
import type { AddressInfo } from 'node:net'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { describeCustom, findAccount, listOrcaAccounts, parseRoutes, readSelectedHome } from './accounts.ts'
import { assignsConfigDir, pinnedCommand, shellQuote } from './launch.ts'
import { defaultOrcaDataDir, isWslPath, normalizeKey, pathFromWorkspaceId, repoRootFromCommonDir } from './paths.ts'
import { RepoResolver } from './repo.ts'
import { Router, parseAgents, type ListedWorkspace, type RouterSettings } from './router.ts'
import { grantFolderTrust } from './trust.ts'
import { keychainService, parseUsageWindows, requestUsage, UsageTracker, usageFromResponse } from './usage.ts'

test('default Orca data folder per platform', () => {
  assert.equal(
    defaultOrcaDataDir('win32', { USERPROFILE: 'C:\\Users\\shin' }),
    'C:\\Users\\shin\\AppData\\Roaming\\orca'
  )
  assert.equal(defaultOrcaDataDir('darwin', { HOME: '/Users/s' }), '/Users/s/Library/Application Support/orca')
  assert.equal(defaultOrcaDataDir('linux', { HOME: '/home/s' }), '/home/s/.config/orca')
  assert.equal(defaultOrcaDataDir('linux', {}), null)
})

test('keys ignore separators, case on Windows, and trailing slashes', () => {
  assert.equal(normalizeKey('C:/Repos/Orca-Helm/', 'win32'), 'c:\\repos\\orca-helm')
  assert.equal(normalizeKey('/repos/a/', 'linux'), '/repos/a')
  assert.equal(repoRootFromCommonDir('C:/Repos/app/.git\n', 'win32'), 'C:/Repos/app')
  assert.equal(repoRootFromCommonDir('/srv/bare.git', 'linux'), '/srv/bare.git')
})

test('workspace ids carry the worktree path after ::', () => {
  assert.equal(pathFromWorkspaceId('repo-1::C:\\work\\app-wt'), 'C:\\work\\app-wt')
  assert.equal(pathFromWorkspaceId('repo-1::/home/s/app'), '/home/s/app')
  assert.equal(pathFromWorkspaceId('repo-1::/home/s/app::workspace:abc-1'), '/home/s/app')
  assert.equal(pathFromWorkspaceId('folder:abc'), null)
  assert.equal(pathFromWorkspaceId('identity:wt2:local:abc'), null)
  assert.equal(pathFromWorkspaceId('plain'), null)
  assert.equal(pathFromWorkspaceId('r::\\\\wsl.localhost\\Ubuntu\\x'), '\\\\wsl.localhost\\Ubuntu\\x')
})

test('WSL paths are only recognized on Windows', () => {
  assert.equal(isWslPath('\\\\wsl.localhost\\Ubuntu\\home\\s', 'win32'), true)
  assert.equal(isWslPath('\\\\wsl$\\Ubuntu\\home\\s', 'win32'), true)
  assert.equal(isWslPath('//wsl.localhost/Ubuntu/home/s', 'win32'), true)
  assert.equal(isWslPath('C:\\work', 'win32'), false)
  assert.equal(isWslPath('\\\\wsl.localhost\\x', 'darwin'), false)
})

test('agents setting', () => {
  assert.deepEqual([...parseAgents(undefined)], ['claude', 'claude-agent-teams'])
  assert.deepEqual([...parseAgents(' claude , codex ')], ['claude', 'codex'])
  assert.deepEqual(parseRoutes({ a: 'x', b: '', c: 1 }), { a: 'x' })
})

// Orca's guard in its `claude` shell function, reduced to what decides the account
// (src/shared/claude-shell-function.ts): a pane value wins unless it is Orca's or the user's own.
const ORCA_FUNCTION = [
  'function claude {',
  '  if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "${ORCA_CLAUDE_INJECTED_CONFIG_DIR:-}" ] &&',
  '    { [ -z "${ORCA_CLAUDE_USER_CONFIG_DIR:-}" ] || [ "${CLAUDE_CONFIG_DIR%/}" != "${ORCA_CLAUDE_USER_CONFIG_DIR%/}" ]; }; then',
  '    echo "$CLAUDE_CONFIG_DIR"; return',
  '  fi',
  '  echo /selected',
  '}'
].join('\n')

const PANE = { CLAUDE_CONFIG_DIR: '/selected', ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/selected' }

function run(shellPath: string, setup: string, command: string, env: Record<string, string> = PANE): string {
  // eval, as a typed line: aliases and functions defined above it are in effect.
  const script = `${setup}\n${ORCA_FUNCTION}\neval ${shellQuote(command)}`
  return execFileSync(shellPath, ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
}

const SHELLS = [
  { path: '/bin/bash', aliases: 'shopt -s expand_aliases' },
  { path: '/bin/zsh', aliases: '' }
].filter(({ path }) => existsSync(path))

test('a pin survives Orca function in every supported shell', () => {
  const home = "/Users/s/Library/Application Support/orca/it's"
  for (const { path } of SHELLS) {
    assert.equal(run(path, '', pinnedCommand('claude', home)), home, path)
    assert.equal(run(path, '', pinnedCommand('sleep 0 && claude', home)), home, `${path}: past the first command`)
    assert.equal(run(path, '', pinnedCommand('claude; claude', home)), `${home}\n${home}`, `${path}: every claude on the line`)
  }
})

test('a pin survives being the folder the user exports', () => {
  const pane = { ...PANE, ORCA_CLAUDE_USER_CONFIG_DIR: '/mine' }
  for (const { path } of SHELLS) {
    assert.equal(run(path, '', 'CLAUDE_CONFIG_DIR=/mine claude', pane), '/selected', `${path}: the problem being fixed`)
    assert.equal(run(path, '', pinnedCommand('claude', '/mine'), pane), '/mine', path)
    assert.equal(run(path, '', pinnedCommand('sleep 0 && claude', '/mine'), pane), '/mine', path)
  }
})

test('a pin survives a compound alias', () => {
  for (const { path, aliases } of SHELLS) {
    const setup = `${aliases}\nalias claude='true && claude'`
    assert.equal(run(path, setup, 'CLAUDE_CONFIG_DIR=/pin claude'), '/selected', `${path}: the problem being fixed`)
    assert.equal(run(path, setup, pinnedCommand('claude', '/pin')), '/pin', path)
  }
})

test('a pin survives a login profile in the setup wrapper', () => {
  const home = tempDir('pin-profile-')
  writeFileSync(join(home, '.bash_profile'), 'export CLAUDE_CONFIG_DIR=/personal\n')
  const wrapper = `bash -lc 'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"'`
  const pinned = pinnedCommand(wrapper, "/a b/it's")
  const output = execFileSync('/bin/bash', ['-c', pinned], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, ORCA_SEQUENCED_STARTUP_SCRIPT: 'printenv CLAUDE_CONFIG_DIR', ...PANE }
  })
  assert.equal(output.trim(), "/a b/it's")
})

test('the setup wrapper refuses a real command that sets the folder itself', () => {
  const wrapper = `bash -lc 'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"'`
  const env = {
    PATH: process.env.PATH,
    HOME: tempDir('pin-profile-'),
    ORCA_SEQUENCED_STARTUP_SCRIPT: 'eval "$ORCA_SEQUENCED_STARTUP_COMMAND"',
    ORCA_SEQUENCED_STARTUP_COMMAND: 'CLAUDE_CONFIG_DIR=/other printenv CLAUDE_CONFIG_DIR'
  }
  assert.throws(() => execFileSync('/bin/bash', ['-c', pinnedCommand(wrapper, '/pin')], { env, stdio: 'pipe' }))
})

test('an assignment survives a shell setup that unset the variable', () => {
  for (const { path } of SHELLS) {
    const output = execFileSync(path, ['-c', `unset CLAUDE_CONFIG_DIR\n${pinnedCommand('/usr/bin/printenv CLAUDE_CONFIG_DIR', '/pin')}`], {
      encoding: 'utf8'
    })
    assert.equal(output.trim(), '/pin', path)
  }
})

test('a shell that rejects the forms stops rather than starting the selected account', { skip: !existsSync('/bin/tcsh') }, () => {
  for (const command of ['echo STARTED', 'claude']) {
    const line = pinnedCommand(command, '/pin').replace(`'claude'`, `'echo' STARTED`)
    const result = spawnSync('/bin/tcsh', ['-c', line], { encoding: 'utf8' })
    assert.ok(!result.stdout.includes('STARTED'), line)
  }
})

test('the forms Orca parser depends on', () => {
  assert.equal(pinnedCommand('claude', '/a b'), `ORCA_CLAUDE_USER_CONFIG_DIR= CLAUDE_CONFIG_DIR='/a b' 'claude'`)
  assert.equal(pinnedCommand('claude --x "y"', '/a'), `ORCA_CLAUDE_USER_CONFIG_DIR= CLAUDE_CONFIG_DIR='/a' 'claude' --x "y"`)
  const assign = `ORCA_CLAUDE_USER_CONFIG_DIR= && export CLAUDE_CONFIG_DIR='/a' &&`
  assert.equal(pinnedCommand('/opt/claude', '/a'), `${assign} /opt/claude`)
  assert.equal(pinnedCommand('claude-wrapper', '/a'), `${assign} claude-wrapper`)
  assert.equal(pinnedCommand('claude --version && claude', '/a'), `${assign} claude --version && claude`)
  assert.equal(pinnedCommand('claude; claude', '/a'), `${assign} claude; claude`)
  assert.ok(pinnedCommand(`claude 'a; b && c'`, '/a').endsWith(`'claude' 'a; b && c'`), 'a prompt is not a separator')
  assert.ok(pinnedCommand(`claude "a; b"`, '/a').endsWith(`'claude' "a; b"`))
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
})

test('recognizes a command that sets the folder itself', () => {
  assert.equal(assignsConfigDir('CLAUDE_CONFIG_DIR=/me claude'), true)
  assert.equal(assignsConfigDir('env CLAUDE_CONFIG_DIR=/me claude'), true)
  assert.equal(assignsConfigDir('claude --x'), false)
  assert.equal(assignsConfigDir(`CLAUDE_CONFIG_DIR='/me' claude`), true)
  assert.equal(assignsConfigDir(`claude 'explain CLAUDE_CONFIG_DIR=/x usage'`), false, 'a launch prompt')
})

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function trustFixture(config: unknown = { oauthAccount: { emailAddress: 'a@b.c' }, keep: 1 }) {
  const home = tempDir('pin-trust-')
  const file = join(home, '.claude.json')
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 })
  const workspace = tempDir('pin-ws-')
  const read = () => JSON.parse(readFileSync(file, 'utf8'))
  return { home, file, workspace, read }
}

test('trust is added once, keeping the rest of the file and its mode', async () => {
  const { home, file, workspace, read } = trustFixture({ keep: 1, projects: { '/other': { x: 1 } } })
  assert.equal(await grantFolderTrust(home, workspace), 'granted')
  const config = read()
  assert.equal(config.keep, 1)
  assert.deepEqual(config.projects['/other'], { x: 1 })
  assert.equal(config.projects[workspace].hasTrustDialogAccepted, true)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(existsSync(`${file}.lock`), false, 'lock released')
  assert.equal(await grantFolderTrust(home, workspace), 'unchanged')
})

test('trust keeps existing project fields and covers a symlinked workspace', async () => {
  const { home, workspace, read } = trustFixture({ projects: { [workspace0()]: { allowedTools: [] } } })
  const link = join(tempDir('pin-link-'), 'wt')
  symlinkSync(workspace, link)
  assert.equal(await grantFolderTrust(home, link), 'granted')
  const { projects } = read()
  assert.equal(projects[link].hasTrustDialogAccepted, true)
  assert.equal(projects[workspace].hasTrustDialogAccepted, true)
})

function workspace0(): string {
  return '/never/matches'
}

test('trust leaves a locked, damaged or missing config alone', async () => {
  const locked = trustFixture()
  mkdirSync(`${locked.file}.lock`)
  assert.equal(await grantFolderTrust(locked.home, locked.workspace), 'locked')
  assert.equal(locked.read().projects, undefined)
  assert.equal(existsSync(`${locked.file}.lock`), true, "another writer's lock is not removed")

  const damaged = trustFixture('{not json')
  assert.equal(await grantFolderTrust(damaged.home, damaged.workspace), 'unreadable')
  assert.equal(readFileSync(damaged.file, 'utf8'), '{not json')

  const wrongShape = trustFixture({ projects: [] })
  assert.equal(await grantFolderTrust(wrongShape.home, wrongShape.workspace), 'unreadable')

  assert.equal(await grantFolderTrust(tempDir('pin-empty-'), locked.workspace), 'missing-config')
})

test('trust is never granted on home, its parents or the root', async () => {
  const { home, read } = trustFixture()
  for (const folder of [homedir(), dirname(homedir()), '/']) {
    assert.equal(await grantFolderTrust(home, folder), 'too-broad', folder)
  }
  assert.equal(read().projects, undefined)
})

test('a failed write leaves no copy of the config behind', async () => {
  const { home, file, workspace } = trustFixture()
  const target = join(home, 'real.json')
  renameSync(file, target)
  symlinkSync(target, file)
  // A read-only folder stops the temp file; the lock lives beside the link, so make it stop there.
  const readOnly = tempDir('pin-ro-')
  const inside = join(readOnly, 'real.json')
  renameSync(target, inside)
  rmSync(file)
  symlinkSync(inside, file)
  chmodSync(readOnly, 0o500)
  try {
    await assert.rejects(grantFolderTrust(home, workspace))
    assert.deepEqual(readdirSync(readOnly), ['real.json'])
    assert.equal(existsSync(`${file}.lock`), false, 'lock released')
  } finally {
    chmodSync(readOnly, 0o700)
  }
})

test('sign-in and trust both read the file Claude prefers', async () => {
  const home = tempDir('pin-legacy-')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'old@x' } }))
  writeFileSync(join(home, '.config.json'), JSON.stringify({ oauthAccount: { emailAddress: 'active@x' } }))
  assert.equal(describeCustom({ id: 'c', label: '', home }).label, 'active@x')
  assert.equal(await grantFolderTrust(home, tempDir('pin-ws-')), 'granted')
  assert.ok(JSON.parse(readFileSync(join(home, '.config.json'), 'utf8')).projects)
  assert.equal(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects, undefined)
})

test('a git failure leaves the project unknown and is not remembered', async () => {
  const repo = tempDir('pin-repo-')
  execFileSync('git', ['-C', repo, 'init', '-q'])
  const resolver = new RepoResolver(process.platform)
  const saved = process.env.PATH
  process.env.PATH = '/nonexistent'
  try {
    assert.equal((await resolver.keyFor(repo)).kind, 'unknown')
  } finally {
    process.env.PATH = saved
  }
  assert.deepEqual(await resolver.keyFor(repo), { kind: 'key', key: normalizeKey(repo, process.platform) })
})

test('a folder outside any repository keys to its real path, a missing one is absent', async () => {
  const folder = tempDir('pin-folder-')
  const link = join(tempDir('pin-link-'), 'other-name')
  symlinkSync(folder, link)
  const resolver = new RepoResolver(process.platform)
  const key = { kind: 'key', key: normalizeKey(folder, process.platform) }
  assert.deepEqual(await resolver.keyFor(folder), key)
  assert.deepEqual(await resolver.keyFor(link), key)
  assert.deepEqual(await resolver.keyFor('/definitely/not/here'), { kind: 'absent' })
})

test('a .git file cannot borrow a repository', async () => {
  const { root, repo, worktree } = fixture()
  const resolver = new RepoResolver(process.platform)
  const repoKey = normalizeKey(repo, process.platform)
  assert.deepEqual(await resolver.keyFor(worktree), { kind: 'key', key: repoKey }, 'a real worktree')
  const nested = join(repo, 'src', 'deep')
  mkdirSync(nested, { recursive: true })
  assert.deepEqual(await resolver.keyFor(nested), { kind: 'key', key: repoKey }, 'a folder inside the repo')

  const toMain = join(root, 'forged-main')
  mkdirSync(toMain)
  writeFileSync(join(toMain, '.git'), `gitdir: ${join(repo, '.git')}\n`)
  assert.deepEqual(await resolver.keyFor(toMain), { kind: 'key', key: normalizeKey(toMain, process.platform) }, 'its own project')

  const [admin] = readdirSync(join(repo, '.git', 'worktrees'))
  const toWorktree = join(root, 'forged-worktree')
  mkdirSync(toWorktree)
  writeFileSync(join(toWorktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', admin ?? '')}\n`)
  assert.equal((await resolver.keyFor(toWorktree)).kind, 'unknown', 'refused while anything is pinned')
})

test('a moved worktree is unknown, and a bare repository and its worktree are one project', async () => {
  const { root, worktree } = fixture()
  const resolver = new RepoResolver(process.platform)
  const moved = join(root, 'moved-away')
  renameSync(worktree, moved)
  assert.equal((await resolver.keyFor(moved)).kind, 'unknown')

  const bare = join(root, 'bare.git')
  execFileSync('git', ['init', '-q', '--bare', bare])
  const tree = execFileSync('git', ['-C', bare, 'hash-object', '-t', 'tree', '-w', '/dev/null'], { encoding: 'utf8' }).trim()
  const commit = execFileSync('git', ['-C', bare, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', '-m', 'x', tree], { encoding: 'utf8' }).trim()
  const linked = join(root, 'bare-wt')
  execFileSync('git', ['-C', bare, 'worktree', 'add', '-q', '--detach', linked, commit], { stdio: 'pipe' })
  const bareKey = { kind: 'key', key: normalizeKey(bare, process.platform) }
  assert.deepEqual(await resolver.keyFor(linked), bareKey)
  assert.deepEqual(await resolver.keyFor(bare), bareKey)
})

test('a submodule is its own project', async () => {
  const { root, repo } = fixture()
  const inner = join(root, 'inner')
  mkdirSync(inner)
  execFileSync('git', ['-C', inner, 'init', '-q'])
  execFileSync('git', ['-C', inner, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  execFileSync('git', ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'], { stdio: 'pipe' })
  const sub = join(repo, 'sub')
  assert.deepEqual(await new RepoResolver(process.platform).keyFor(sub), { kind: 'key', key: normalizeKey(sub, process.platform) })
})

test('a worktree whose main repo is unreachable is unknown, then recovers', async () => {
  const { repo, worktree } = fixture()
  const moved = `${repo}-moved`
  const resolver = new RepoResolver(process.platform)
  renameSync(repo, moved)
  assert.equal((await resolver.keyFor(worktree)).kind, 'unknown')
  renameSync(moved, repo)
  assert.deepEqual(await resolver.keyFor(worktree), { kind: 'key', key: normalizeKey(repo, process.platform) })
})

function fixture() {
  const root = tempDir('capp-')
  const data = join(root, 'orca')
  const makeAccount = (id: string, email: string | null, runtime = 'host') => {
    const home = join(data, 'claude-profiles', id, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(data, 'claude-profiles', id, 'profile.json'), JSON.stringify({ runtime }))
    if (email) {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
    }
    return home
  }
  const workHome = makeAccount('acct-work', 'me@work.example')
  makeAccount('acct-empty', null)
  makeAccount('acct-wsl', 'wsl@work.example', 'wsl')
  mkdirSync(join(data, 'claude-profiles', 'acct-unfinished', 'home'), { recursive: true })
  const select = (home: string) => writeFileSync(join(data, 'claude-profiles', 'selected-host'), `${home}\n`)
  // A repo with one extra worktree.
  const repo = join(root, 'app')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const worktree = join(root, 'app-feature')
  git('worktree', 'add', '-q', worktree)
  const other = join(root, 'plain-folder')
  mkdirSync(other)
  return { root, data, workHome, repo, worktree, other, select }
}

function routerFor(
  fix: ReturnType<typeof fixture>,
  overrides: {
    platform?: NodeJS.Platform
    workspaces?: ListedWorkspace[]
    list?: () => Promise<ListedWorkspace[]>
  } = {}
) {
  const workspaces: ListedWorkspace[] = overrides.workspaces ?? [
    { id: 'identity:wt2:local:main', kind: 'worktree', name: 'main', path: fix.repo, branch: 'main', hostId: 'local' },
    { id: 'identity:wt2:local:feature', kind: 'worktree', name: 'feature', path: fix.worktree, branch: 'feature', hostId: 'local' },
    { id: 'folder:f1', kind: 'folder', name: 'plain', path: fix.other, branch: null, hostId: null }
  ]
  const state = {
    routes: {} as Record<string, string>,
    settings: { orcaDataDir: fix.data, agents: parseAgents(undefined), onPinFailure: 'deny' } as RouterSettings
  }
  const router = new Router({
    platform: overrides.platform ?? process.platform,
    listWorkspaces: overrides.list ?? (async () => workspaces),
    getRoutes: () => state.routes,
    getCustomAccounts: () => [],
    getSettings: () => state.settings
  })
  return { router, state }
}

const hookId = (path: string) => `repo-uuid::${path}`

test('lists finished host accounts with their sign-in', () => {
  const { data } = fixture()
  const accounts = listOrcaAccounts(data)
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a.signedIn]))
  assert.deepEqual(byId, { 'acct-work': true, 'acct-empty': false })
  assert.equal(accounts.find((a) => a.id === 'acct-work')?.label, 'me@work.example')
  assert.equal(findAccount('acct-wsl', data, []), null)
  assert.equal(findAccount('../acct-work', data, []), null, 'an id cannot leave claude-profiles')
})

test('reads the selected account pointer', () => {
  const { data, workHome, select } = fixture()
  assert.equal(readSelectedHome(data), null, 'no file')
  select('')
  assert.equal(readSelectedHome(data), null, 'System default')
  select(workHome)
  assert.equal(readSelectedHome(data), workHome)
  assert.equal(readSelectedHome(join(data, 'absent')), undefined, 'not known, rather than System default')
})

test('routes a worktree to its main repo account and leaves others alone', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  const projects = await router.projects()
  const app = projects.find((p) => p.name === 'app')
  assert.ok(app, 'main repo and its worktree are one project')
  assert.equal(app.workspaces, 2)
  state.routes = { [app.key]: 'acct-work' }

  const fromWorktree = await router.decide({ agent: 'claude', workspaceId: hookId(fix.worktree), command: 'claude', env: {} })
  assert.equal(fromWorktree.kind, 'route')
  if (fromWorktree.kind === 'route') {
    assert.equal(fromWorktree.account.home, fix.workHome)
    assert.equal(fromWorktree.path, fix.worktree)
    assert.equal(fromWorktree.mechanism, 'command')
  }

  assert.equal((await router.decide({ agent: 'codex', workspaceId: hookId(fix.worktree), command: 'claude', env: {} })).kind, 'pass')
  assert.equal((await router.decide({ agent: 'claude', workspaceId: 'folder:f1', command: 'claude', env: {} })).kind, 'pass')
  assert.equal((await router.decide({ agent: 'claude', workspaceId: null, command: 'claude', env: {} })).kind, 'pass')

  state.routes = { [app.key]: 'gone' }
  assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'deny')
  state.settings.onPinFailure = 'pass'
  assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'pass')
})

test('finds a folder workspace through the list and pins it', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  await router.projects()
  state.routes = { [normalizeKey(fix.other, process.platform)]: 'acct-work' }
  assert.equal((await router.decide({ agent: 'claude', workspaceId: 'folder:f1', command: 'claude', env: {} })).kind, 'route')
})

test('the selected account needs no pin, and Agent Teams can only run on it', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  state.routes = { [normalizeKey(fix.repo, process.platform)]: 'acct-work' }
  assert.equal((await router.decide({ agent: 'claude-agent-teams', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'deny')

  fix.select(fix.workHome)
  const same = await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })
  assert.equal(same.kind, 'pass')
  assert.equal((await router.decide({ agent: 'claude-agent-teams', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'pass')
})

test('another value for the folder is refused only on a pinned project', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  const preset = { agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: { CLAUDE_CONFIG_DIR: '/other' } }
  assert.equal((await router.decide(preset)).kind, 'pass', 'nothing pinned')
  state.routes = { '/elsewhere': 'acct-work' }
  assert.equal((await router.decide(preset)).kind, 'pass', 'this project is not pinned')
  state.routes = { [normalizeKey(fix.repo, process.platform)]: 'acct-work' }
  assert.equal((await router.decide(preset)).kind, 'deny')
  assert.equal((await router.decide({ ...preset, env: { CLAUDE_CONFIG_DIR: fix.workHome } })).kind, 'route', 'same folder')
})

test('a Claude command that sets the folder itself is refused on a pinned project', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  const custom = { agent: 'claude', workspaceId: hookId(fix.repo), command: 'CLAUDE_CONFIG_DIR=/me claude', env: {} }
  assert.equal((await router.decide(custom)).kind, 'pass')
  state.routes = { [normalizeKey(fix.repo, process.platform)]: 'acct-work' }
  assert.equal((await router.decide(custom)).kind, 'deny')
  fix.select(fix.workHome)
  assert.equal((await router.decide(custom)).kind, 'deny', 'also when the pin is the selected account')
})

test('a pin with no routed claude agent says so', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  state.routes = { [normalizeKey(fix.repo, process.platform)]: 'acct-work' }
  state.settings.agents = parseAgents('codex')
  assert.match((await router.projects()).find((p) => p.name === 'app')?.problem ?? '', /Routed agents/)
})

test('a signed-out account is refused rather than sent to its login prompt', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  state.routes = { [normalizeKey(fix.repo, process.platform)]: 'acct-empty' }
  assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'deny')
})

test('an unknown project is refused only when something is pinned', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  const saved = process.env.PATH
  process.env.PATH = '/nonexistent'
  try {
    assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'pass')
    state.routes = { '/some/other/repo': 'acct-work' }
    assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'deny')
  } finally {
    process.env.PATH = saved
  }
})

test('a folder id the list cannot answer in time is refused without blocking the hook', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix, { list: () => new Promise(() => {}) })
  state.routes = { '/some/repo': 'acct-work' }
  const started = Date.now()
  assert.equal((await router.decide({ agent: 'claude', workspaceId: 'folder:new', command: 'claude', env: {} })).kind, 'deny')
  assert.ok(Date.now() - started < 1500, 'stays inside the 2 s hook budget')
})

test('remote workspaces are not routed, even at a path that also exists here', async () => {
  const fix = fixture()
  const workspaces: ListedWorkspace[] = [
    { id: 'identity:wt2:ssh%3Abox:1', kind: 'worktree', name: 'r', path: fix.repo, branch: null, hostId: 'ssh:box' },
    { id: 'identity:wt2:local:2', kind: 'worktree', name: 'gone', path: '/definitely/not/here', branch: null, hostId: 'local' }
  ]
  const { router, state } = routerFor(fix, { workspaces })
  const projects = await router.projects()
  assert.deepEqual(projects, [], 'the panel lists neither')
  state.routes = { [normalizeKey(fix.repo, process.platform)]: 'acct-work', '/definitely/not/here': 'acct-work' }
  assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'pass')
  assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId('/definitely/not/here'), command: 'claude', env: {} })).kind, 'pass')
})

test('a path both local and remote cannot say which host launches, so a pin there is refused', async () => {
  const fix = fixture()
  const workspaces: ListedWorkspace[] = [
    { id: 'identity:wt2:local:1', kind: 'worktree', name: 'a', path: fix.repo, branch: 'main', hostId: 'local' },
    { id: 'identity:wt2:ssh%3Abox:2', kind: 'worktree', name: 'a', path: fix.repo, branch: 'main', hostId: 'ssh:box' }
  ]
  const { router, state } = routerFor(fix, { workspaces })
  await router.refreshWorkspaces()
  const launch = { agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} }
  state.routes = { '/elsewhere': 'acct-work' }
  assert.equal((await router.decide(launch)).kind, 'pass', 'not pinned, so either host is fine')
  state.routes = { [normalizeKey(fix.repo, process.platform)]: 'acct-work' }
  assert.equal((await router.decide(launch)).kind, 'deny')
  assert.equal((await router.focusedPin({ displayName: 'a', branch: 'main' })).kind, 'none', 'a remote twin borrows no pin')
  assert.ok((await router.projects())[0]?.problem, 'the panel says so before a launch does')
})

test('Windows pins through the environment only while Orca selects no account', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix, { platform: 'win32' })
  const app = (await router.projects()).find((p) => p.workspaces === 2)
  assert.ok(app)
  state.routes = { [app.key]: 'acct-work' }
  const open = await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })
  assert.equal(open.kind === 'route' && open.mechanism, 'env')
  fix.select(join(fix.data, 'claude-profiles', 'acct-empty', 'home'))
  assert.equal((await router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'deny')
  assert.ok((await router.projects()).find((p) => p.workspaces === 2)?.problem, 'the panel says so too')

  const unknown = routerFor(fix, { platform: 'win32' })
  unknown.state.settings.orcaDataDir = join(fix.root, 'wrong-folder')
  unknown.state.routes = { [app.key]: 'acct-work' }
  // The account cannot be found under a wrong data folder either; a custom one would reach the check.
  assert.equal((await unknown.router.decide({ agent: 'claude', workspaceId: hookId(fix.repo), command: 'claude', env: {} })).kind, 'deny')
})

test('a route whose project is gone stays visible', async () => {
  const fix = fixture()
  const { router, state } = routerFor(fix)
  state.routes = { '/moved/away': 'acct-work' }
  const stale = (await router.projects()).find((p) => p.key === '/moved/away')
  assert.equal(stale?.stale, true)
  assert.equal(stale?.workspaces, 0)
})

test('the focused pin answers only when every match agrees', async () => {
  const fix = fixture()
  const second = join(fix.root, 'second')
  mkdirSync(second)
  const workspaces: ListedWorkspace[] = [
    { id: 'a', kind: 'worktree', name: 'main', path: fix.repo, branch: 'main', hostId: 'local' },
    { id: 'b', kind: 'folder', name: 'main', path: second, branch: 'main', hostId: 'local' }
  ]
  const { router, state } = routerFor(fix, { workspaces })
  await router.refreshWorkspaces()
  const repoKey = normalizeKey(fix.repo, process.platform)
  const secondKey = normalizeKey(second, process.platform)
  const focus = { displayName: 'main', branch: 'main' }

  assert.equal((await router.focusedPin(null)).kind, 'none')
  assert.equal((await router.focusedPin(focus)).kind, 'none', 'nothing pinned')

  state.routes = { [repoKey]: 'acct-work' }
  assert.equal((await router.focusedPin(focus)).kind, 'none', 'the matches disagree')

  state.routes = { [repoKey]: 'acct-work', [secondKey]: 'acct-work' }
  const agreed = await router.focusedPin(focus)
  assert.equal(agreed.kind === 'pinned' && agreed.account.id, 'acct-work')

  state.routes = { [repoKey]: 'gone', [secondKey]: 'gone' }
  assert.equal((await router.focusedPin(focus)).kind, 'broken')
  rmSync(second, { recursive: true })
})

test('reads the usage windows a plan has', () => {
  // Shapes seen from the real endpoint, for a Max plan without a session window and a Team plan.
  const max = {
    five_hour: null,
    seven_day: { utilization: 24, resets_at: '2026-11-11T20:00:00.501648+00:00' },
    extra_usage: { utilization: null, is_enabled: false },
    limits: [
      { kind: 'weekly_all', percent: 24, resets_at: '2026-11-11T20:00:00+00:00' },
      { kind: 'weekly_scoped', percent: 3, resets_at: '2026-11-11T20:00:00+00:00', scope: { model: { display_name: 'Fable' } } }
    ],
    spend: {}
  }
  assert.deepEqual(
    parseUsageWindows(max).map(({ label, percent }) => [label, percent]),
    [['주간', 24], ['주간 (Fable)', 3]]
  )
  assert.equal(parseUsageWindows(max)[0]?.resetsAt, new Date('2026-11-11T20:00:00.501648+00:00').getTime())

  const team = { five_hour: { utilization: 0, resets_at: '2026-11-06T08:20:00+00:00' }, seven_day: { utilization: 150 } }
  assert.deepEqual(parseUsageWindows(team), [
    { label: '5시간', percent: 0, resetsAt: new Date('2026-11-06T08:20:00+00:00').getTime() },
    { label: '주간', percent: 100, resetsAt: null }
  ])

  const seconds = parseUsageWindows({ seven_day: { utilization: 1, resets_at: 1762300000 } })
  assert.equal(seconds[0]?.resetsAt, 1762300000_000)
  const numericString = parseUsageWindows({ seven_day: { utilization: 1, resets_at: '1762300000' } })
  assert.equal(numericString[0]?.resetsAt, 1762300000_000)

  const scoped = (percent: number) => ({ kind: 'weekly_scoped', percent, scope: { model: { display_name: 'X' } } })
  assert.deepEqual(parseUsageWindows({ limits: [scoped(1), scoped(2)] }).map((w) => w.percent), [1], 'one per label')

  assert.deepEqual(parseUsageWindows(null), [])
  assert.deepEqual(parseUsageWindows({ five_hour: { utilization: 'many' }, limits: 'x' }), [])
})

test('says what each usage response means', () => {
  assert.equal(usageFromResponse(200, JSON.stringify({ seven_day: { utilization: 1 } }), undefined, 5).status, 'ok')
  assert.equal(usageFromResponse(200, '{}', undefined, 5).status, 'unavailable')
  assert.equal(usageFromResponse(200, '<html>', undefined, 5).status, 'unavailable')
  assert.equal(usageFromResponse(401, 'expired', undefined, 5).status, 'expired')
  assert.equal(usageFromResponse(500, '', undefined, 5).status, 'unavailable')
  const limited = usageFromResponse(429, '', '120', 5)
  assert.equal(limited.status, 'rate-limited')
  assert.equal(limited.retryAfterMs, 120_000)
  assert.equal(usageFromResponse(429, '', 'soon', 5).retryAfterMs, 300_000)
  assert.equal(usageFromResponse(429, '', '7200', 5).retryAfterMs, 7_200_000)
  const now = Date.parse('2026-11-06T00:00:00Z')
  assert.equal(usageFromResponse(429, '', 'Fri, 06 Nov 2026 02:00:00 GMT', now).retryAfterMs, 7_200_000)
})

test('names the Keychain item as Claude Code does', () => {
  // The value macOS really holds for this folder name is covered by the live check in docs/DESIGN.md.
  assert.match(keychainService('/a b'), /^Claude Code-credentials-[0-9a-f]{8}$/)
  assert.equal(keychainService('/caf\u00e9'), keychainService('/cafe\u0301'), 'NFC, one spelling')
})

test('asks one account at a time, no more often than it should', async () => {
  let now = 1_000_000
  const asked: string[] = []
  const tracker = new UsageTracker(async (home) => {
    asked.push(home)
    return home === '/limited'
      ? { status: 'rate-limited', message: 'x', checkedAt: now, retryAfterMs: 30 * 60_000 }
      : { status: 'ok', windows: [], checkedAt: now }
  }, () => now)
  const accounts = [{ id: 'a', home: '/a' }, { id: 'l', home: '/limited' }]

  assert.equal(await tracker.refresh(accounts), true)
  assert.deepEqual(asked, ['/a', '/limited'])
  assert.deepEqual(Object.keys(tracker.snapshot(['a', 'l', 'gone'])), ['a', 'l'])

  assert.equal(await tracker.refresh(accounts), false, 'still fresh')
  assert.equal(await tracker.refresh(accounts, { force: true }), false, 'the button has a floor too')

  now += 61_000
  await tracker.refresh(accounts, { force: true })
  assert.deepEqual(asked, ['/a', '/limited', '/a'], 'a rate limited account waits its turn')

  now += 31 * 60_000
  await tracker.refresh(accounts)
  assert.deepEqual(asked.slice(3), ['/a', '/limited'])
})

test('overlapping refreshes share one run', async () => {
  let calls = 0
  const tracker = new UsageTracker(async () => {
    calls += 1
    return { status: 'ok', windows: [], checkedAt: Date.now() }
  })
  const accounts = [{ id: 'a', home: '/a' }]
  await Promise.all([tracker.refresh(accounts), tracker.refresh(accounts)])
  assert.equal(calls, 1)
})

test('a pressed refresh during a plain run is honoured after it', async () => {
  let now = 1_000_000
  const asked: string[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tracker = new UsageTracker(async (home) => {
    asked.push(home)
    if (home === '/slow') await gate
    return { status: 'ok', windows: [], checkedAt: now }
  }, () => now)
  await tracker.refresh([{ id: 'a', home: '/a' }])
  now += 2 * 60_000
  const accounts = [{ id: 'a', home: '/a' }, { id: 's', home: '/slow' }]
  const plain = tracker.refresh(accounts)
  void tracker.refresh(accounts, { force: true })
  release()
  await plain
  assert.deepEqual(asked, ['/a', '/slow', '/a'], 'the two minute old account is asked again')
})

test('a run stops asking for what is no longer wanted', async () => {
  const asked: string[] = []
  let wanted = true
  const tracker = new UsageTracker(async (home) => {
    asked.push(home)
    wanted = false
    return { status: 'ok', windows: [], checkedAt: Date.now() }
  })
  await tracker.refresh([{ id: 'a', home: '/a' }, { id: 'b', home: '/b' }], { stillWanted: () => wanted })
  assert.deepEqual(asked, ['/a'])
})

test('a response cut off mid-body fails instead of hanging', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '100' })
    response.write('partial', () => response.socket?.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const url = `http://127.0.0.1:${port}/`
    await assert.rejects(requestUsage('fake', http.get as unknown as typeof https.get, url))
  } finally {
    server.close()
  }
})
