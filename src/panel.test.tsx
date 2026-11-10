// The panel as Orca draws it, against a stand-in worker.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'
import type { PanelState } from './protocol.ts'

const account = {
  id: 'a1',
  label: 'me@work.example',
  home: '/orca/claude-profiles/a1/home',
  source: 'orca' as const,
  exists: true,
  signedIn: true
}

const base: PanelState = {
  accounts: [account],
  projects: [{ key: '/repos/app', name: 'app', workspaces: 2, accountId: null, stale: false, problem: null }],
  orcaDataDir: '/orca',
  agents: ['claude'],
  selectedHome: account.home,
  platform: 'darwin',
  onPinFailure: 'deny',
  usage: {},
  lang: 'en'
}

const hostFor = (state: PanelState, onRoute?: (input: unknown) => void) =>
  mockHost({
    requests: {
      'state.get': () => state,
      'route.set': (input: unknown) => {
        onRoute?.(input)
        return state
      }
    }
  })

test('pins a project from its account picker', async () => {
  const seen: unknown[] = []
  const view = await mount(panel, { host: hostFor(base, (input) => seen.push(input)) })
  await view.select({ label: 'app account' }, 'a1')
  assert.deepEqual(seen, [{ key: '/repos/app', accountId: 'a1' }])
  await view.select({ label: 'app account' }, '__orca_default__')
  assert.deepEqual(seen[1], { key: '/repos/app', accountId: null })
  assert.deepEqual(view.errors, [])
  view.unmount()
})

test('speaks the worker language, and tells the worker Orca locale', async () => {
  const seen: unknown[] = []
  const host = mockHost({
    requests: {
      'state.get': (input: unknown) => {
        seen.push(input)
        return { ...base, lang: 'fr' as const, projects: [{ ...base.projects[0], accountId: 'a1', problem: 'x' }] }
      }
    }
  })
  const view = await mount(panel, { host, locale: 'fr-FR' })
  const tree = JSON.stringify(view.tree())
  assert.deepEqual(seen[0], { locale: 'fr-FR' })
  assert.ok(tree.includes('seront refusés'))
  assert.ok(tree.includes('Comptes et utilisation'))
  assert.ok(view.find({ label: 'Compte de app' }))
  assert.ok(view.find({ label: 'Afficher l’utilisation de chaque compte' }))
  view.unmount()
})

test('says which account unpinned launches use', async () => {
  const view = await mount(panel, { host: hostFor(base) })
  assert.ok(JSON.stringify(view.tree()).includes('me@work.example'))
  view.unmount()
})

test('says what a pin that cannot apply will do, per the setting', async () => {
  const projects = [{ ...base.projects[0], accountId: 'a1', problem: 'The pinned account is not signed in.' }]
  const denied = await mount(panel, { host: hostFor({ ...base, projects }) })
  const deniedText = JSON.stringify(denied.tree())
  assert.ok(deniedText.includes('not signed in') && deniedText.includes('will be refused'))
  denied.unmount()

  const passed = await mount(panel, { host: hostFor({ ...base, projects, onPinFailure: 'pass' }) })
  assert.ok(JSON.stringify(passed.tree()).includes('run with the account selected in Orca'))
  passed.unmount()
})

test('offers the manual command with the account folder quoted', async () => {
  const state: PanelState = { ...base, projects: [{ ...base.projects[0], accountId: 'a1' }] }
  const view = await mount(panel, { host: hostFor(state) })
  assert.ok(JSON.stringify(view.tree()).includes(`CLAUDE_CONFIG_DIR='${account.home}' 'claude'`))
  view.unmount()
})

test('shows a request failure', async () => {
  const host = mockHost({
    requests: {
      'state.get': () => base,
      'route.set': () => {
        throw new Error('No such account.')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'app account' }, 'a1')
  assert.ok(view.summary().join('\n').includes('The request could not be processed'))
  view.unmount()
})

test('shows each account usage, and what stopped it', async () => {
  const other = { ...account, id: 'a2', label: 'other@x', home: '/h2' }
  const state: PanelState = {
    ...base,
    accounts: [account, other],
    projects: [{ ...base.projects[0], accountId: 'a1' }],
    usage: {
      a1: { status: 'ok', checkedAt: 1, windows: [{ label: '5-hour', percent: 23.4, resetsAt: 2_000_000_000_000 }, { label: 'Weekly', percent: 5, resetsAt: null }] },
      a2: { status: 'expired', checkedAt: 1, message: 'The token has expired.' }
    }
  }
  const view = await mount(panel, { host: hostFor(state) })
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.includes('5-hour 23% · Weekly 5%'), 'one line on the project card')
  assert.ok(tree.includes('The token has expired.'))
  assert.ok(view.find({ label: '5-hour usage' }))
  assert.deepEqual(view.warnings, [])
  view.unmount()
})

test('usage is off until the switch is pressed, and says what turning it on does', async () => {
  const seen: unknown[] = []
  const host = mockHost({
    requests: {
      'state.get': () => ({ ...base, usage: null }),
      'usage.setEnabled': (input: unknown) => {
        seen.push(input)
        return base
      }
    }
  })
  const view = await mount(panel, { host })
  const tree = JSON.stringify(view.tree())
  assert.ok(!tree.includes('Checking usage'))
  assert.ok(tree.includes('stored login token'), 'the switch explains itself')
  assert.equal(view.valueOf({ label: "Show each account's usage" }), false)
  await view.toggle({ label: "Show each account's usage" })
  assert.deepEqual(seen, [{ enabled: true }])
  assert.equal(view.valueOf({ label: "Show each account's usage" }), true)
  view.unmount()
})
