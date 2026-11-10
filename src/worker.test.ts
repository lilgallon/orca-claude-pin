// Runs the worker the way Orca does (`orca plugin test .`), hook chain included.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeKey } from './core/paths.ts'
import * as main from './worker.ts'

function orcaData() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'capp-worker-')))
  const data = join(root, 'orca')
  const home = join(data, 'claude-profiles', 'acct-1', 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(data, 'claude-profiles', 'acct-1', 'profile.json'), '{}')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }))
  const project = join(root, 'proj')
  mkdirSync(project)
  return { root, data, home, project, key: normalizeKey(project, process.platform) }
}

const listing = (project: string) => ({
  'workspace.list': {
    workspaces: [{ id: 'folder:p', kind: 'folder', name: 'proj', path: project, branch: null, hostId: null }],
    truncated: false
  },
  'workspace.readContext': { branch: '', displayName: 'proj', terminals: [] }
})

const launch = (agent: string, workspaceId: string) => ({
  agent,
  workspaceId,
  workspaceKind: 'folder' as const,
  command: agent,
  env: {}
})

test('pins a routed project in the command and the environment, and nothing otherwise', async () => {
  const { data, home, project, key } = orcaData()
  const host = mockHost({
    settings: { orcaDataDir: data },
    storage: { routes: { [key]: 'acct-1' } },
    results: listing(project)
  })
  const worker = await mountWorker(main, { host })

  const routed = await worker.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.equal(routed.kind, 'continue')
  if (routed.kind === 'continue') {
    assert.equal(routed.event.env.CLAUDE_CONFIG_DIR, home)
    assert.match(routed.event.command, /^ORCA_CLAUDE_USER_CONFIG_DIR= CLAUDE_CONFIG_DIR='.*' 'claude'$/)
    assert.ok(routed.event.command.includes(home))
  }

  const codex = await worker.hooks.fire('agent.launch.before', launch('codex', 'folder:p'))
  assert.deepEqual(codex.kind === 'continue' && codex.event.env, {})
  assert.equal(codex.kind === 'continue' && codex.event.command, 'codex')

  const state = await worker.request('state.get', {})
  assert.equal(state.accounts[0]?.label, 'a@b.c')
  assert.equal(state.projects[0]?.accountId, 'acct-1')
  assert.equal(state.selectedHome, null)

  await worker.request('route.set', { key, accountId: null })
  const cleared = await worker.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.deepEqual(cleared.kind === 'continue' && cleared.event.env, {})

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('marks the workspace trusted in the pinned account, unless told not to', async () => {
  const { data, home, project, key } = orcaData()
  const file = join(home, '.claude.json')
  const read = () => JSON.parse(readFileSync(file, 'utf8'))

  const off = await mountWorker(main, {
    host: mockHost({
      settings: { orcaDataDir: data, trustWorkspaces: false },
      storage: { routes: { [key]: 'acct-1' } },
      results: listing(project)
    })
  })
  await off.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.equal(read().projects, undefined)
  await off.deactivate()

  const on = await mountWorker(main, {
    host: mockHost({
      settings: { orcaDataDir: data },
      storage: { routes: { [key]: 'acct-1' } },
      results: listing(project)
    })
  })
  await on.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.equal(read().projects[project].hasTrustDialogAccepted, true)
  await on.deactivate()
})

test('refuses a launch whose account folder is gone', async () => {
  const { data, project, key } = orcaData()
  const host = mockHost({
    settings: { orcaDataDir: data },
    storage: { routes: { [key]: 'missing' } },
    results: listing(project)
  })
  const worker = await mountWorker(main, { host })
  const decided = await worker.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.equal(decided.kind, 'deny')
  await worker.deactivate()
})

test('fails closed when the pins cannot be read, instead of treating them as empty', async () => {
  const { data, project } = orcaData()
  const host = mockHost({
    capabilities: ['workspace:read', 'settings:own'],
    settings: { orcaDataDir: data },
    results: listing(project)
  })
  const worker = await mountWorker(main, { host, hooks: [{ event: 'agent.launch.before', onError: 'deny' }] })
  const decided = await worker.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.equal(decided.kind, 'deny')
  await worker.deactivate()
})

test('the status bar shows the focused project pin and hides otherwise', async () => {
  const { data, project, key } = orcaData()
  const host = mockHost({
    settings: { orcaDataDir: data },
    storage: { routes: { [key]: 'acct-1' } },
    results: listing(project)
  })
  const worker = await mountWorker(main, { host })
  const last = () => host.callsOf('statusBar.update').at(-1) as { text?: string; visible?: boolean; tone?: string }
  assert.equal(last().text, 'Claude Pin: a@b.c')
  assert.equal(last().tone, 'accent')

  await worker.emit('workspace.changed', { context: null })
  assert.equal(last().visible, false)

  await worker.emit('workspace.changed', { context: { branch: '', displayName: 'proj', terminals: [] } })
  assert.equal(last().visible, true)

  await worker.request('route.set', { key, accountId: null })
  await worker.emit('workspace.changed', { context: { branch: '', displayName: 'proj', terminals: [] } })
  assert.equal(last().visible, false)
  await worker.deactivate()
})

test('checks what the panel sends', async () => {
  const { root, data, project, key } = orcaData()
  const host = mockHost({
    settings: { orcaDataDir: data },
    storage: { routes: { [key]: 'acct-1' } },
    results: listing(project)
  })
  const worker = await mountWorker(main, { host })
  await assert.rejects(worker.request('route.set', { key, accountId: 'nobody' }), /No such account/)
  await assert.rejects(worker.request('custom.add', { label: '', home: 'relative/path' }), /absolute path/)
  await assert.rejects(worker.request('custom.add', { label: '', home: join(root, 'absent') }), /does not exist/)
  await assert.rejects(worker.request('custom.add', { label: '', home: join(homedir(), '.claude') }), /default folder/)

  const folder = join(root, 'work-login')
  mkdirSync(folder)
  writeFileSync(join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@b.c' } }))
  const added = await worker.request('custom.add', { label: 'Work', home: `${folder}/` })
  const account = added.accounts.find((candidate) => candidate.source === 'custom')
  assert.equal(account?.home, folder, 'one spelling, or the Keychain entry differs')
  await assert.rejects(worker.request('custom.add', { label: '', home: folder }), /already added/)

  await worker.request('route.set', { key, accountId: account?.id ?? null })
  await assert.rejects(worker.request('custom.remove', { id: account?.id ?? '' }), /project uses this account/)
  await worker.request('route.set', { key, accountId: null })
  const removed = await worker.request('custom.remove', { id: account?.id ?? '' })
  assert.equal(removed.accounts.some((candidate) => candidate.source === 'custom'), false)
  await worker.deactivate()
})

test('usage stays off until the person turns it on, and an account with no token reaches no server', async () => {
  const { data, project, key } = orcaData()
  const worker = await mountWorker(main, {
    host: mockHost({ settings: { orcaDataDir: data }, storage: { routes: { [key]: 'acct-1' } }, results: listing(project) })
  })
  assert.equal((await worker.request('state.get', {})).usage, null)
  await worker.request('usage.refresh', {})
  assert.equal((await worker.request('state.get', {})).usage, null, 'the refresh button reads no token while off')

  const on = await worker.request('usage.setEnabled', { enabled: true })
  assert.notEqual(on.usage, null)
  assert.equal(worker.host.data().settings.showUsage, true)
  await worker.request('usage.refresh', {})
  const { usage } = await worker.request('state.get', {})
  assert.equal(usage?.['acct-1']?.status, 'unavailable', 'a temp folder has no stored login')

  const off = await worker.request('usage.setEnabled', { enabled: false })
  assert.equal(off.usage, null)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
