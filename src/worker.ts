// Routes each project's Claude Code launches to its own account.
//
// Orca runs `agent.launch.before` right before it starts an agent CLI in a terminal. A routed
// launch gets the account's CLAUDE_CONFIG_DIR in its command line, because Orca overwrites that
// variable in the environment after the hook whenever it has an account selected. docs/DESIGN.md
// has the evidence and the launches no plugin can reach.
import type { OrcaWorkerApi } from 'orca/worker'
import { isAbsolute, join } from 'node:path'
import { describeCustom, parseCustomAccounts, parseRoutes, type CustomAccount } from './core/accounts.ts'
import { pinnedCommand } from './core/launch.ts'
import { defaultOrcaDataDir, normalizeKey } from './core/paths.ts'
import { parseAgents, Router, type FocusContext, type ListedWorkspace, type RouterSettings } from './core/router.ts'
import { grantFolderTrust } from './core/trust.ts'
import { UsageTracker } from './core/usage.ts'
import type { PanelState } from './protocol.ts'

const ROUTES_KEY = 'routes'
const CUSTOM_KEY = 'customAccounts'
const STATUS_ITEM = 'pin'
const WARM_UP_LIMIT_MS = 3000
/** Orca ignores a longer deny reason and lets the launch through. */
const DENY_REASON_MAX = 500
const STATUS_TEXT_MAX = 64
const STATUS_TOOLTIP_MAX = 256

type Settings = RouterSettings & { trustWorkspaces: boolean; showUsage: boolean }

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const platform = process.platform
  let routes: Record<string, string> = {}
  let custom: CustomAccount[] = []
  let settings: Settings = {
    orcaDataDir: defaultOrcaDataDir(platform, process.env),
    agents: parseAgents(undefined),
    onPinFailure: 'deny',
    trustWorkspaces: true,
    showUsage: false
  }
  let focus: FocusContext | null = null

  async function readSettings(): Promise<void> {
    const all = ((await orca.settings.get()) ?? {}) as Record<string, unknown>
    const override = typeof all.orcaDataDir === 'string' ? all.orcaDataDir.trim() : ''
    settings = {
      orcaDataDir: override || defaultOrcaDataDir(platform, process.env),
      agents: parseAgents(all.agents),
      onPinFailure: all.onPinFailure === 'pass' ? 'pass' : 'deny',
      trustWorkspaces: all.trustWorkspaces !== false,
      showUsage: all.showUsage === true
    }
  }

  // Orca refuses host calls while it reconciles plugins. Empty routes would then read as "nothing
  // is pinned" and start pinned projects on the wrong account, so an unloaded state must block.
  let loaded = false
  async function ensureLoaded(): Promise<void> {
    if (loaded) {
      return
    }
    routes = parseRoutes(await orca.storage.get(ROUTES_KEY))
    custom = parseCustomAccounts(await orca.storage.get(CUSTOM_KEY))
    await readSettings()
    loaded = true
  }

  /** Listeners that reject are fatal to a worker, and Orca allows it only three restarts. */
  function guarded(label: string, task: () => Promise<void>): Promise<void> {
    return task().catch((error: unknown) => orca.log(`${label} failed: ${String(error)}`))
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

  let statusRun = 0
  /** Updates only what Orca shows; nothing here may stop a launch or a panel request. */
  async function updateStatus(): Promise<void> {
    statusRun += 1
    const run = statusRun
    await ensureLoaded()
    const pin = await router.focusedPin(focus)
    if (run !== statusRun) {
      return // Focus moved on while this looked up the older workspace.
    }
    if (pin.kind === 'none') {
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, visible: false })
      return
    }
    if (pin.kind === 'broken') {
      await orca.host.call('statusBar.update', {
        id: STATUS_ITEM,
        visible: true,
        text: 'Claude Pin: check account',
        tone: 'danger',
        tooltip: pin.reason.slice(0, STATUS_TOOLTIP_MAX)
      })
      return
    }
    await orca.host.call('statusBar.update', {
      id: STATUS_ITEM,
      visible: true,
      text: `Claude Pin: ${pin.account.label}`.slice(0, STATUS_TEXT_MAX),
      tone: 'accent',
      tooltip: `New Claude terminals run with ${pin.account.label}. Restored or resumed sessions and claude typed by hand use the account selected in Orca.`.slice(
        0,
        STATUS_TOOLTIP_MAX
      )
    })
  }

  function notifyChanged(): void {
    orca.panels.post('state.changed', {})
    void guarded('status update', updateStatus)
  }

  orca.storage.onDidChange(({ key }) => {
    void guarded('storage reload', async () => {
      if (key === ROUTES_KEY) {
        routes = parseRoutes(await orca.storage.get(ROUTES_KEY))
      } else if (key === CUSTOM_KEY) {
        custom = parseCustomAccounts(await orca.storage.get(CUSTOM_KEY))
      }
      notifyChanged()
    })
  })
  orca.settings.onDidChange(() => {
    void guarded('settings reload', async () => {
      await readSettings()
      notifyChanged()
    })
  })

  orca.hooks.on('agent.launch.before', async (event, next) => {
    await ensureLoaded()
    const decision = await router.decide(event)
    if (decision.kind === 'deny') {
      orca.log(`denied ${event.agent} in ${event.workspaceId}: ${decision.reason}`)
      return { deny: decision.reason.slice(0, DENY_REASON_MAX) }
    }
    if (decision.kind === 'pass') {
      orca.log(`passed ${event.agent} in ${event.workspaceId}: ${decision.reason}`)
      return undefined
    }
    const { account, key, mechanism, path } = decision
    if (settings.trustWorkspaces) {
      // A prompt is the worst case here, so a failure must not cost the launch its pin.
      const trust = await grantFolderTrust(account.home, path).catch((error: unknown) => String(error))
      if (trust !== 'granted' && trust !== 'unchanged') {
        orca.log(`could not mark ${path} trusted for ${account.label}: ${trust}`)
      }
    }
    orca.log(`${event.agent} in ${key} → ${account.label} (${mechanism})`)
    return next({
      ...event,
      command: mechanism === 'command' ? pinnedCommand(event.command, account.home) : event.command,
      env: { ...event.env, CLAUDE_CONFIG_DIR: account.home }
    })
  })

  // Warm the caches so the first launch decides well inside the hook's 2 s budget.
  orca.events.on('workspace.created', ({ path }) =>
    guarded('workspace refresh', async () => {
      await router.warmPath(path)
      await router.refreshWorkspaces()
      notifyChanged()
    })
  )
  orca.events.on('workspace.removed', ({ path }) =>
    guarded('workspace refresh', async () => {
      router.forgetPath(path)
      await router.refreshWorkspaces()
      notifyChanged()
    })
  )
  orca.events.on('workspace.changed', ({ context }) => {
    focus = context
    return guarded('focus update', async () => {
      await router.refreshWorkspaces()
      await updateStatus()
    })
  })

  const usage = new UsageTracker()

  /** In the background, so a panel opens at once; only an open panel ever starts this. */
  function refreshUsage(force = false): void {
    if (!settings.showUsage) {
      return
    }
    const accounts = router.accounts().filter((account) => account.exists && account.signedIn)
    void guarded('usage refresh', async () => {
      const stillWanted = (id: string) => settings.showUsage && router.accounts().some((account) => account.id === id)
      if (await usage.refresh(accounts, { force, stillWanted })) {
        orca.panels.post('state.changed', {})
      }
    })
  }

  async function state(): Promise<PanelState> {
    await ensureLoaded()
    const accounts = router.accounts()
    return {
      accounts,
      projects: await router.projects(),
      orcaDataDir: settings.orcaDataDir,
      agents: [...settings.agents],
      selectedHome: router.selectedHome(),
      platform,
      onPinFailure: settings.onPinFailure,
      usage: settings.showUsage ? usage.snapshot(accounts.map((account) => account.id)) : null
    }
  }

  orca.panels.handle('state.get', async () => {
    const current = await state()
    refreshUsage()
    return current
  })

  orca.panels.handle('usage.setEnabled', async ({ enabled }) => {
    await ensureLoaded()
    await orca.settings.set('showUsage', enabled === true)
    await readSettings()
    const current = await state()
    refreshUsage()
    return current
  })

  orca.panels.handle('usage.refresh', async () => {
    const current = await state()
    refreshUsage(true)
    return current
  })

  orca.panels.handle('route.set', async ({ key, accountId }) => {
    await ensureLoaded()
    if (typeof key !== 'string' || !key) {
      throw invalid('Unknown project.')
    }
    if (accountId !== null && !router.accounts().some((account) => account.id === accountId)) {
      throw invalid('No such account.')
    }
    const next = { ...routes }
    if (accountId) {
      next[key] = accountId
    } else {
      delete next[key]
    }
    // Saved first: a pin held only in memory would vanish at the next restart.
    await orca.storage.set(ROUTES_KEY, next)
    routes = next
    return state()
  })

  orca.panels.handle('custom.add', async ({ label, home }) => {
    await ensureLoaded()
    const folder = normalizeKey(home.trim(), platform)
    if (!isAbsolute(folder)) {
      throw invalid('The account folder must be an absolute path.')
    }
    const defaultFolder = process.env.HOME ?? process.env.USERPROFILE
    if (defaultFolder && folder === normalizeKey(join(defaultFolder, '.claude'), platform)) {
      // Naming the default folder explicitly changes Claude's Keychain entry, and so the login.
      throw invalid('The default folder ~/.claude cannot be used.')
    }
    const added: CustomAccount = { id: `custom-${Date.now().toString(36)}`, label: label.trim(), home: folder }
    if (!describeCustom(added).exists) {
      throw invalid('The folder does not exist. Sign in to Claude with that folder first.')
    }
    if (custom.some((account) => normalizeKey(account.home, platform) === folder)) {
      throw invalid('This folder is already added.')
    }
    const next = [...custom, added]
    await orca.storage.set(CUSTOM_KEY, next)
    custom = next
    return state()
  })

  orca.panels.handle('custom.remove', async ({ id }) => {
    await ensureLoaded()
    if (Object.values(routes).includes(id)) {
      throw invalid('A project uses this account. Unpin it first.')
    }
    const next = custom.filter((account) => account.id !== id)
    await orca.storage.set(CUSTOM_KEY, next)
    custom = next
    return state()
  })

  // Spent against Orca's 10 s start limit rather than the first hook's 2 s. A failure here is
  // retried by the hook, and must not fail activation: Orca allows a worker three restarts.
  const warmUp = (async () => {
    await ensureLoaded()
    await router.projects()
    focus = await orca.host.call('workspace.readContext', {})
    await updateStatus()
  })().catch((error: unknown) => orca.log(`warm-up failed: ${String(error)}`))
  await Promise.race([warmUp, new Promise((resolve) => setTimeout(resolve, WARM_UP_LIMIT_MS).unref())])
}
