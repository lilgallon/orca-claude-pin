// Plain Node tests for the routing logic: `orca plugin test .` or
// `node --experimental-strip-types --test src/core/core.test.ts`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listOrcaAccounts, parseRoutes } from './accounts.ts'
import { defaultOrcaDataDir, normalizeKey, pathFromWorkspaceId, repoRootFromCommonDir } from './paths.ts'
import { Router, parseAgents, type ListedWorkspace, type RouterSettings } from './router.ts'

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
  assert.equal(pathFromWorkspaceId('folder:abc'), null)
  assert.equal(pathFromWorkspaceId('plain'), null)
})

test('agents setting', () => {
  assert.deepEqual([...parseAgents(undefined)], ['claude', 'claude-agent-teams'])
  assert.deepEqual([...parseAgents(' claude , codex ')], ['claude', 'codex'])
  assert.deepEqual(parseRoutes({ a: 'x', b: '', c: 1 }), { a: 'x' })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'capp-'))
  const data = join(root, 'orca')
  const makeAccount = (id: string, email: string | null) => {
    const home = join(data, 'claude-profiles', id, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(data, 'claude-profiles', id, 'profile.json'), '{}')
    if (email) {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
    }
    return home
  }
  const workHome = makeAccount('acct-work', 'me@work.example')
  makeAccount('acct-empty', null)
  mkdirSync(join(data, 'claude-profiles', 'selected-host'), { recursive: true })
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
  return { data, workHome, repo, worktree, other }
}

test('lists Orca accounts with their sign-in', () => {
  const { data } = fixture()
  const accounts = listOrcaAccounts(data)
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a.signedIn]))
  assert.deepEqual(byId, { 'acct-work': true, 'acct-empty': false })
  assert.equal(accounts.find((a) => a.id === 'acct-work')?.label, 'me@work.example')
})

test('routes a worktree to its main repo account and leaves others alone', async () => {
  const { data, workHome, repo, worktree, other } = fixture()
  const platform = process.platform
  const workspaces: ListedWorkspace[] = [
    { id: `r1::${repo}`, kind: 'worktree', name: 'app', path: repo },
    { id: 'identity:wt', kind: 'worktree', name: 'feature', path: worktree },
    { id: 'folder:f1', kind: 'folder', name: 'plain', path: other }
  ]
  let routes: Record<string, string> = {}
  const settings: RouterSettings = {
    orcaDataDir: data,
    agents: parseAgents(undefined),
    onMissingAccount: 'deny'
  }
  const router = new Router({
    platform,
    listWorkspaces: async () => workspaces,
    getRoutes: () => routes,
    getCustomAccounts: () => [],
    getSettings: () => settings
  })

  const projects = await router.projects()
  const app = projects.find((p) => p.name === 'app')
  assert.ok(app, 'main repo and its worktree are one project')
  assert.equal(app.workspaces, 2)
  routes = { [app.key]: 'acct-work' }

  const fromWorktree = await router.decide({ agent: 'claude', workspaceId: 'identity:wt', env: {} })
  assert.equal(fromWorktree.kind, 'route')
  assert.equal(fromWorktree.kind === 'route' && fromWorktree.account.home, workHome)

  assert.equal((await router.decide({ agent: 'codex', workspaceId: 'identity:wt', env: {} })).kind, 'pass')
  assert.equal((await router.decide({ agent: 'claude', workspaceId: 'folder:f1', env: {} })).kind, 'pass')
  assert.equal(
    (await router.decide({ agent: 'claude', workspaceId: 'identity:wt', env: { CLAUDE_CONFIG_DIR: '/x' } })).kind,
    'pass'
  )

  routes = { [app.key]: 'gone' }
  assert.equal((await router.decide({ agent: 'claude', workspaceId: `r1::${repo}`, env: {} })).kind, 'deny')
  settings.onMissingAccount = 'pass'
  assert.equal((await router.decide({ agent: 'claude', workspaceId: `r1::${repo}`, env: {} })).kind, 'pass')

  const stale = (await router.projects()).find((p) => p.accountId === 'gone')
  assert.equal(stale?.stale, false)
})

test('remote workspaces are not routed', async () => {
  const router = new Router({
    platform: process.platform,
    listWorkspaces: async () => [{ id: 'ssh-1', kind: 'worktree', name: 'r', path: '/definitely/not/here' }],
    getRoutes: () => ({ '/definitely/not/here': 'a' }),
    getCustomAccounts: () => [],
    getSettings: () => ({ orcaDataDir: null, agents: parseAgents(undefined), onMissingAccount: 'deny' })
  })
  assert.equal((await router.decide({ agent: 'claude', workspaceId: 'ssh-1', env: {} })).kind, 'pass')
})
