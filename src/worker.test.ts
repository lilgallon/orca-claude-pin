// Runs the worker the way Orca does (`orca plugin test .`), hook chain included.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeKey } from './core/paths.ts'
import * as main from './worker.ts'

function orcaData() {
  const root = mkdtempSync(join(tmpdir(), 'capp-worker-'))
  const data = join(root, 'orca')
  const home = join(data, 'claude-profiles', 'acct-1', 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(data, 'claude-profiles', 'acct-1', 'profile.json'), '{}')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }))
  const project = join(root, 'proj')
  mkdirSync(project)
  return { data, home, project }
}

const launch = (agent: string, workspaceId: string) => ({
  agent,
  workspaceId,
  workspaceKind: 'folder' as const,
  command: agent,
  env: {}
})

test('adds CLAUDE_CONFIG_DIR for a routed project and nothing otherwise', async () => {
  const { data, home, project } = orcaData()
  const key = normalizeKey(project, process.platform)
  const host = mockHost({
    settings: { orcaDataDir: data },
    storage: { routes: { [key]: 'acct-1' } },
    results: {
      'workspace.list': {
        workspaces: [{ id: 'folder:p', kind: 'folder', name: 'proj', path: project, branch: null, hostId: null }],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })

  const routed = await worker.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.equal(routed.kind, 'continue')
  assert.equal(routed.kind === 'continue' && routed.event.env.CLAUDE_CONFIG_DIR, home)

  const codex = await worker.hooks.fire('agent.launch.before', launch('codex', 'folder:p'))
  assert.deepEqual(codex.kind === 'continue' && codex.event.env, {})

  const state = await worker.request('state.get', {})
  assert.equal(state.accounts[0]?.label, 'a@b.c')
  assert.equal(state.projects[0]?.accountId, 'acct-1')

  await worker.request('route.set', { key, accountId: null })
  const cleared = await worker.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.deepEqual(cleared.kind === 'continue' && cleared.event.env, {})

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('refuses a launch whose account folder is gone', async () => {
  const { data, project } = orcaData()
  const host = mockHost({
    settings: { orcaDataDir: data },
    storage: { routes: { [normalizeKey(project, process.platform)]: 'missing' } },
    results: {
      'workspace.list': {
        workspaces: [{ id: 'folder:p', kind: 'folder', name: 'proj', path: project, branch: null, hostId: null }],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const decided = await worker.hooks.fire('agent.launch.before', launch('claude', 'folder:p'))
  assert.equal(decided.kind, 'deny')
  await worker.deactivate()
})
