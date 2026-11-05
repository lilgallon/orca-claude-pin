// Routes each project's Claude Code launches to its own account.
//
// Orca runs `agent.launch.before` right before it starts an agent CLI in a terminal. For a
// routed agent in a routed project this adds CLAUDE_CONFIG_DIR = that account's folder. Orca's
// `claude` shell function lets a CLAUDE_CONFIG_DIR set for the pane win over its own global
// account selection, so the rest of Orca keeps working as before.
import type { OrcaWorkerApi } from 'orca/worker'
import { isAbsolute } from 'node:path'
import { parseCustomAccounts, parseRoutes, type CustomAccount } from './core/accounts.ts'
import { defaultOrcaDataDir, normalizeKey } from './core/paths.ts'
import { parseAgents, Router, type ListedWorkspace, type RouterSettings } from './core/router.ts'
import type { PanelState } from './protocol.ts'

const ROUTES_KEY = 'routes'
const CUSTOM_KEY = 'customAccounts'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const platform = process.platform
  let routes: Record<string, string> = parseRoutes(await orca.storage.get(ROUTES_KEY))
  let custom: CustomAccount[] = parseCustomAccounts(await orca.storage.get(CUSTOM_KEY))
  let settings = await readSettings()

  async function readSettings(): Promise<RouterSettings> {
    const all = ((await orca.settings.get()) ?? {}) as Record<string, unknown>
    const override = typeof all.orcaDataDir === 'string' ? all.orcaDataDir.trim() : ''
    return {
      orcaDataDir: override || defaultOrcaDataDir(platform, process.env),
      agents: parseAgents(all.agents),
      onMissingAccount: all.onMissingAccount === 'pass' ? 'pass' : 'deny'
    }
  }

  const router = new Router({
    platform,
    listWorkspaces: async () => {
      const { workspaces } = (await orca.host.call('workspace.list', {})) as {
        workspaces: ListedWorkspace[]
      }
      return workspaces
    },
    getRoutes: () => routes,
    getCustomAccounts: () => custom,
    getSettings: () => settings
  })

  orca.storage.onDidChange(async ({ key }) => {
    if (key === ROUTES_KEY) {
      routes = parseRoutes(await orca.storage.get(ROUTES_KEY))
    } else if (key === CUSTOM_KEY) {
      custom = parseCustomAccounts(await orca.storage.get(CUSTOM_KEY))
    }
  })
  orca.settings.onDidChange(async () => {
    settings = await readSettings()
  })

  orca.hooks.on('agent.launch.before', async (event, next) => {
    const started = Date.now()
    const decision = await router.decide(event)
    if (decision.kind === 'deny') {
      orca.log(`denied ${event.agent} in ${event.workspaceId}: ${decision.reason}`)
      return { deny: decision.reason }
    }
    if (decision.kind === 'pass') {
      return undefined
    }
    orca.log(
      `${event.agent} in ${decision.key} → ${decision.account.label} (${Date.now() - started} ms)`
    )
    return next({ ...event, env: { ...event.env, CLAUDE_CONFIG_DIR: decision.account.home } })
  })

  // Warm the caches so the first launch decides well inside the hook's 2 s budget.
  orca.events.on('workspace.created', async ({ workspaceId, path }) => {
    router.rememberWorkspace(workspaceId, path)
    await router.keyOf(workspaceId)
  })
  orca.events.on('workspace.removed', ({ workspaceId, path }) => {
    router.forgetWorkspace(workspaceId, path)
  })
  void router.projects().catch((error: unknown) => orca.log(`warm-up failed: ${String(error)}`))

  async function state(): Promise<PanelState> {
    return {
      accounts: router.accounts(),
      projects: await router.projects(),
      orcaDataDir: settings.orcaDataDir,
      agents: [...settings.agents]
    }
  }

  orca.panels.handle('state.get', () => state())

  orca.panels.handle('route.set', async ({ key, accountId }) => {
    const next = { ...routes }
    if (accountId) {
      next[key] = accountId
    } else {
      delete next[key]
    }
    routes = next
    await orca.storage.set(ROUTES_KEY, next)
    return state()
  })

  orca.panels.handle('custom.add', async ({ label, home }) => {
    const folder = home.trim()
    if (!isAbsolute(folder)) {
      throw Object.assign(new Error('계정 폴더는 절대 경로여야 합니다.'), { code: 'invalid_params' })
    }
    const duplicate = custom.some((account) => normalizeKey(account.home, platform) === normalizeKey(folder, platform))
    if (!duplicate) {
      custom = [...custom, { id: `custom-${Date.now().toString(36)}`, label: label.trim(), home: folder }]
      await orca.storage.set(CUSTOM_KEY, custom)
    }
    return state()
  })

  orca.panels.handle('custom.remove', async ({ id }) => {
    custom = custom.filter((account) => account.id !== id)
    await orca.storage.set(CUSTOM_KEY, custom)
    return state()
  })
}
