// The decision behind the launch hook, kept free of Orca's APIs so it can be tested in plain
// Node. The worker feeds it workspaces, routes and settings.
import {
  describeCustom,
  findAccount,
  listOrcaAccounts,
  readSelectedHome,
  type Account,
  type CustomAccount
} from './accounts.ts'
import { assignsConfigDir } from './launch.ts'
import { displayName, isWslPath, normalizeKey, pathFromWorkspaceId, type Platform } from './paths.ts'
import { RepoResolver } from './repo.ts'

export type ListedWorkspace = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch?: string | null
  hostId?: string | null
}

export type RouterSettings = {
  orcaDataDir: string | null
  agents: ReadonlySet<string>
  onPinFailure: 'deny' | 'pass'
}

export type LaunchEvent = {
  agent: string
  workspaceId: string | null
  command: string
  env: Record<string, string>
}

export type Decision =
  | { kind: 'pass'; reason: string }
  | { kind: 'route'; key: string; account: Account; path: string; mechanism: 'command' | 'env' }
  | { kind: 'deny'; reason: string }

export type ProjectRow = {
  key: string
  name: string
  workspaces: number
  accountId: string | null
  /** A route whose project Orca no longer lists. */
  stale: boolean
  /** Why this project's pin cannot apply right now. */
  problem: string | null
}

export type FocusContext = { branch: string; displayName: string }

export type FocusedPin =
  | { kind: 'none' }
  | { kind: 'pinned'; account: Account }
  | { kind: 'broken'; reason: string }

export type RouterDeps = {
  platform: Platform
  listWorkspaces: () => Promise<ListedWorkspace[]>
  getRoutes: () => Record<string, string>
  getCustomAccounts: () => CustomAccount[]
  getSettings: () => RouterSettings
}

/** `orca claude-teams` asks Orca for the selected account's environment and spawns Claude itself. */
const IGNORES_COMMAND_PIN = 'claude-agent-teams'
/** `workspace.list` runs git on local repos and can take 5 s; the hook has 2 s in all. */
const LIST_WAIT_IN_HOOK_MS = 800

export function parseAgents(value: unknown): Set<string> {
  const text = typeof value === 'string' ? value : 'claude,claude-agent-teams'
  return new Set(
    text
      .split(/[\s,]+/)
      .map((agent) => agent.trim())
      .filter(Boolean)
  )
}

function ambiguousPathProblem(path: string, project: string): string {
  return `${path} exists both on this machine and on a remote host, so the pin of project ${project} cannot be applied.`
}

/** Only `local` and a missing host are this machine; `ssh:` and `runtime:` rows run elsewhere. */
function isLocalRow(row: ListedWorkspace, platform: Platform): boolean {
  return (row.hostId === 'local' || row.hostId == null) && !isWslPath(row.path, platform)
}

export class Router {
  private readonly deps: RouterDeps
  private readonly repos: RepoResolver
  /** List ids and hook ids differ for most worktrees, so rows are joined by path as well. */
  private rowsById = new Map<string, ListedWorkspace>()
  private rowsByPath = new Map<string, ListedWorkspace[]>()
  private listed: ListedWorkspace[] = []
  private refreshing: Promise<ListedWorkspace[]> | null = null

  constructor(deps: RouterDeps, repos?: RepoResolver) {
    this.deps = deps
    this.repos = repos ?? new RepoResolver(deps.platform)
  }

  accounts(): Account[] {
    const { orcaDataDir } = this.deps.getSettings()
    return [...listOrcaAccounts(orcaDataDir), ...this.deps.getCustomAccounts().map(describeCustom)]
  }

  selectedHome(): string | null {
    return readSelectedHome(this.deps.getSettings().orcaDataDir) ?? null
  }

  /** Reads Orca's workspace list into the caches. Calls that overlap share one read. */
  refreshWorkspaces(): Promise<ListedWorkspace[]> {
    this.refreshing ??= this.deps
      .listWorkspaces()
      .then((listed) => {
        this.listed = listed
        this.rowsById = new Map(listed.map((row) => [row.id, row]))
        this.rowsByPath = new Map()
        for (const row of listed) {
          const key = normalizeKey(row.path, this.deps.platform)
          this.rowsByPath.set(key, [...(this.rowsByPath.get(key) ?? []), row])
        }
        return listed
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  forgetPath(path: string): void {
    this.repos.forget(path)
  }

  /** Warms the project key of a path, for a workspace Orca just created. */
  async warmPath(path: string): Promise<void> {
    await this.repos.keyFor(path)
  }

  private async pathOf(workspaceId: string): Promise<string | null> {
    const known = this.rowsById.get(workspaceId)?.path ?? pathFromWorkspaceId(workspaceId)
    if (known) {
      return known
    }
    // shortcut: only `folder:` ids the cache has not seen reach this wait, a slow list loses them
    // once and the launch is refused; upgrade if Orca adds the path to the hook payload.
    await Promise.race([
      this.refreshWorkspaces().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, LIST_WAIT_IN_HOOK_MS))
    ])
    return this.rowsById.get(workspaceId)?.path ?? null
  }

  /**
   * The hook names no host, and the same path can exist here and on a remote host. Only a path no
   * local row claims is remote; when both claim it, the launch's host cannot be known.
   */
  private hostOfPath(path: string): 'local' | 'remote' | 'ambiguous' {
    const { platform } = this.deps
    if (isWslPath(path, platform)) {
      return 'remote'
    }
    const rows = this.rowsByPath.get(normalizeKey(path, platform)) ?? []
    const remote = rows.filter((row) => !isLocalRow(row, platform)).length
    if (remote === 0) {
      return 'local'
    }
    return remote === rows.length ? 'remote' : 'ambiguous'
  }

  /** Whether a pin can apply at all: the checks the launch, the panel and the status bar share. */
  private checkPin(accountId: string, project: string): { account: Account; isSelected: boolean } | { problem: string } {
    const { orcaDataDir, agents } = this.deps.getSettings()
    const { platform } = this.deps
    if (!agents.has('claude')) {
      return { problem: `The plugin's Routed agents setting does not include claude, so the pin of project ${project} does not apply.` }
    }
    const account = findAccount(accountId, orcaDataDir, this.deps.getCustomAccounts())
    if (!account?.exists) {
      return { problem: `The Claude account (${accountId}) pinned to project ${project} cannot be found. Pin it again in the Claude Pin panel.` }
    }
    if (!account.signedIn) {
      return { problem: `The Claude account (${account.label}) pinned to project ${project} is not signed in.` }
    }
    const selected = readSelectedHome(orcaDataDir)
    const isSelected = selected != null && normalizeKey(selected, platform) === normalizeKey(account.home, platform)
    if (isSelected) {
      return { account, isSelected }
    }
    // The hook is not told which shell will run the command, and Windows shells share no syntax
    // for this. Orca's overwrite only leaves the variable alone under System default.
    if (platform === 'win32' && selected !== null) {
      return { problem: `On Windows, Orca's account selection must be System default for the project pin (${account.label}) to apply.` }
    }
    return { account, isSelected }
  }

  private refuse(reason: string): Decision {
    return this.deps.getSettings().onPinFailure === 'deny' ? { kind: 'deny', reason } : { kind: 'pass', reason }
  }

  async decide(event: LaunchEvent): Promise<Decision> {
    const settings = this.deps.getSettings()
    const routes = this.deps.getRoutes()
    if (!settings.agents.has(event.agent)) {
      return { kind: 'pass', reason: `agent ${event.agent} is not routed` }
    }
    if (!event.workspaceId) {
      return { kind: 'pass', reason: 'no workspace' }
    }
    if (Object.keys(routes).length === 0) {
      return { kind: 'pass', reason: 'no project is pinned' }
    }
    const path = await this.pathOf(event.workspaceId)
    if (!path) {
      return this.refuse(`Claude Pin could not find where workspace ${event.workspaceId} is. Try again in a moment.`)
    }
    const host = this.hostOfPath(path)
    if (host === 'remote') {
      return { kind: 'pass', reason: `${path} runs on another host` }
    }
    const result = await this.repos.keyFor(path)
    if (result.kind === 'absent') {
      return { kind: 'pass', reason: `${path} is not on this machine` }
    }
    if (result.kind === 'unknown') {
      return this.refuse(`Claude Pin could not determine the project of ${path}: ${result.reason}`)
    }
    const { key } = result
    const accountId = routes[key]
    if (!accountId) {
      return { kind: 'pass', reason: `no route for ${key}` }
    }
    const project = displayName(key, this.deps.platform)
    if (host === 'ambiguous') {
      return this.refuse(ambiguousPathProblem(path, project))
    }
    const pin = this.checkPin(accountId, project)
    if ('problem' in pin) {
      return this.refuse(pin.problem)
    }
    const { account, isSelected } = pin
    const earlier = event.env.CLAUDE_CONFIG_DIR
    if (earlier && normalizeKey(earlier, this.deps.platform) !== normalizeKey(account.home, this.deps.platform)) {
      return this.refuse(`Another plugin set the Claude account folder of project ${project} to ${earlier}.`)
    }
    if (assignsConfigDir(event.command)) {
      return this.refuse(`The launch command sets CLAUDE_CONFIG_DIR, so the pin of project ${project} cannot be applied. Check the agent command setting.`)
    }
    if (isSelected) {
      return { kind: 'pass', reason: `${account.label} is already Orca's selected account` }
    }
    if (event.agent === IGNORES_COMMAND_PIN) {
      return this.refuse(`Agent Teams only run with the account selected in Orca. To use the account pinned to project ${project} (${account.label}), launch regular Claude.`)
    }
    return { kind: 'route', key, account, path, mechanism: this.deps.platform === 'win32' ? 'env' : 'command' }
  }

  /** Every local project Orca lists, plus routes whose project is gone, for the panel. */
  async projects(): Promise<ProjectRow[]> {
    const listed = await this.refreshWorkspaces()
    const routes = this.deps.getRoutes()
    const rows = new Map<string, ProjectRow>()
    for (const workspace of listed) {
      if (!isLocalRow(workspace, this.deps.platform)) {
        continue
      }
      const result = await this.repos.keyFor(workspace.path)
      if (result.kind !== 'key') {
        continue
      }
      const row = rows.get(result.key)
      if (row) {
        row.workspaces += 1
      } else {
        rows.set(result.key, {
          key: result.key,
          name: displayName(result.key, this.deps.platform),
          workspaces: 1,
          accountId: routes[result.key] ?? null,
          stale: false,
          problem: this.problemOf(routes[result.key], result.key)
        })
      }
      const current = rows.get(result.key)
      if (current?.accountId && this.hostOfPath(workspace.path) === 'ambiguous') {
        current.problem = ambiguousPathProblem(workspace.path, current.name)
      }
    }
    for (const [key, accountId] of Object.entries(routes)) {
      if (!rows.has(key)) {
        rows.set(key, {
          key,
          name: displayName(key, this.deps.platform),
          workspaces: 0,
          accountId,
          stale: true,
          problem: this.problemOf(accountId, key)
        })
      }
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private problemOf(accountId: string | undefined, key: string): string | null {
    if (!accountId) {
      return null
    }
    const pin = this.checkPin(accountId, displayName(key, this.deps.platform))
    return 'problem' in pin ? pin.problem : null
  }

  /**
   * shortcut: Orca's focus context has no workspace id, so this matches name and branch and only
   * answers when every match agrees; two repos on `main` with different pins answer none. Upgrade
   * if Orca adds the id to `workspace.changed`.
   */
  async focusedPin(context: FocusContext | null): Promise<FocusedPin> {
    if (!context) {
      return { kind: 'none' }
    }
    const routes = this.deps.getRoutes()
    const { platform } = this.deps
    const matches = this.listed.filter((row) => row.name === context.displayName && (row.branch ?? '') === context.branch)
    const pins = new Set<string | null>()
    let project = ''
    for (const row of matches) {
      // A remote twin counts as unpinned, so it makes the answer ambiguous rather than borrowing.
      const result = isLocalRow(row, platform) ? await this.repos.keyFor(row.path) : null
      const accountId = result?.kind === 'key' ? (routes[result.key] ?? null) : null
      pins.add(accountId)
      if (accountId && result?.kind === 'key') {
        project = displayName(result.key, platform)
      }
    }
    const [accountId] = pins
    if (pins.size !== 1 || !accountId) {
      return { kind: 'none' }
    }
    const pin = this.checkPin(accountId, project)
    return 'problem' in pin ? { kind: 'broken', reason: pin.problem } : { kind: 'pinned', account: pin.account }
  }
}
