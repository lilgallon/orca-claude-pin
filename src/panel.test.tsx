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
  usage: {}
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
  await view.select({ label: 'app 계정' }, 'a1')
  assert.deepEqual(seen, [{ key: '/repos/app', accountId: 'a1' }])
  await view.select({ label: 'app 계정' }, '__orca_default__')
  assert.deepEqual(seen[1], { key: '/repos/app', accountId: null })
  assert.deepEqual(view.errors, [])
  view.unmount()
})

test('says which account unpinned launches use', async () => {
  const view = await mount(panel, { host: hostFor(base) })
  assert.ok(JSON.stringify(view.tree()).includes('me@work.example'))
  view.unmount()
})

test('says what a pin that cannot apply will do, per the setting', async () => {
  const projects = [{ ...base.projects[0], accountId: 'a1', problem: '지정된 계정에 로그인되어 있지 않습니다.' }]
  const denied = await mount(panel, { host: hostFor({ ...base, projects }) })
  const deniedText = JSON.stringify(denied.tree())
  assert.ok(deniedText.includes('로그인되어 있지 않습니다') && deniedText.includes('거부됩니다'))
  denied.unmount()

  const passed = await mount(panel, { host: hostFor({ ...base, projects, onPinFailure: 'pass' }) })
  assert.ok(JSON.stringify(passed.tree()).includes('선택한 계정으로 실행됩니다'))
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
        throw new Error('없는 계정입니다.')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'app 계정' }, 'a1')
  assert.ok(view.summary().join('\n').includes('요청을 처리하지 못했습니다'))
  view.unmount()
})

test('shows each account usage, and what stopped it', async () => {
  const other = { ...account, id: 'a2', label: 'other@x', home: '/h2' }
  const state: PanelState = {
    ...base,
    accounts: [account, other],
    projects: [{ ...base.projects[0], accountId: 'a1' }],
    usage: {
      a1: { status: 'ok', checkedAt: 1, windows: [{ label: '5시간', percent: 23.4, resetsAt: 2_000_000_000_000 }, { label: '주간', percent: 5, resetsAt: null }] },
      a2: { status: 'expired', checkedAt: 1, message: '토큰이 만료되었습니다.' }
    }
  }
  const view = await mount(panel, { host: hostFor(state) })
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.includes('5시간 23% · 주간 5%'), 'one line on the project card')
  assert.ok(tree.includes('토큰이 만료되었습니다.'))
  assert.ok(view.find({ label: '5시간 사용량' }))
  assert.deepEqual(view.warnings, [])
  view.unmount()
})

test('shows no usage when it is turned off', async () => {
  const view = await mount(panel, { host: hostFor({ ...base, usage: null }) })
  assert.ok(!JSON.stringify(view.tree()).includes('사용량 확인 중'))
  view.unmount()
})
