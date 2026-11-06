// The decision behind the launch hook, kept free of Orca's APIs so it can be tested in plain
// Node. The worker feeds it workspaces, routes and settings.
import {
  describeCustom,
  listOrcaAccounts,
  type Account,
  type CustomAccount
} from './accounts.ts'
import { displayName, pathFromWorkspaceId, type Platform } from './paths.ts'
import { RepoResolver } from './repo.ts'

export type ListedWorkspace = { id: string; kind: 'worktree' | 'folder'; name: string; path: string }

export type RouterSettings = {
  orcaDataDir: string | null
  agents: ReadonlySet<string>
  onMissingAccount: 'deny' | 'pass'
}

export type LaunchEvent = {
  agent: string
  workspaceId: string | null
  env: Record<string, string>
}

export type Decision =
  | { kind: 'pass'; reason: string }
  | { kind: 'route'; key: string; account: Account }
  | { kind: 'deny'; reason: string }

export type ProjectRow = {
  key: string
  name: string
  workspaces: number
  accountId: string | null
  /** A route whose project Orca no longer lists. */
  stale: boolean
}

export type RouterDeps = {
  platform: Platform
  listWorkspaces: () => Promise<ListedWorkspace[]>
  getRoutes: () => Record<string, string>
  getCustomAccounts: () => CustomAccount[]
  getSettings: () => RouterSettings
}

export function parseAgents(value: unknown): Set<string> {
  const text = typeof value === 'string' ? value : 'claude,claude-agent-teams'
  return new Set(
    text
      .split(/[\s,]+/)
      .map((agent) => agent.trim())
      .filter(Boolean)
  )
}

export class Router {
  private readonly deps: RouterDeps
  private readonly repos: RepoResolver
  private readonly workspacePaths = new Map<string, string>()

  constructor(deps: RouterDeps, repos?: RepoResolver) {
    this.deps = deps
    this.repos = repos ?? new RepoResolver(deps.platform)
  }

  accounts(): Account[] {
    const { orcaDataDir } = this.deps.getSettings()
    return [...listOrcaAccounts(orcaDataDir), ...this.deps.getCustomAccounts().map(describeCustom)]
  }

  /** Reads Orca's workspace list into the id → path cache; returns it for callers that want it. */
  async refreshWorkspaces(): Promise<ListedWorkspace[]> {
    const listed = await this.deps.listWorkspaces()
    for (const workspace of listed) {
      this.workspacePaths.set(workspace.id, workspace.path)
    }
    return listed
  }

  forgetWorkspace(workspaceId: string, path?: string): void {
    this.workspacePaths.delete(workspaceId)
    if (path) {
      this.repos.forget(path)
    }
  }

  rememberWorkspace(workspaceId: string, path: string): void {
    this.workspacePaths.set(workspaceId, path)
  }

  async pathOf(workspaceId: string): Promise<string | null> {
    const known = this.workspacePaths.get(workspaceId) ?? pathFromWorkspaceId(workspaceId)
    if (known) {
      return known
    }
    await this.refreshWorkspaces()
    return this.workspacePaths.get(workspaceId) ?? null
  }

  async keyOf(workspaceId: string): Promise<string | null> {
    const path = await this.pathOf(workspaceId)
    return path ? this.repos.keyFor(path) : null
  }

  async decide(event: LaunchEvent): Promise<Decision> {
    const settings = this.deps.getSettings()
    if (!settings.agents.has(event.agent)) {
      return { kind: 'pass', reason: `agent ${event.agent} is not routed` }
    }
    if (event.env.CLAUDE_CONFIG_DIR) {
      return { kind: 'pass', reason: 'an earlier plugin already chose CLAUDE_CONFIG_DIR' }
    }
    if (!event.workspaceId) {
      return { kind: 'pass', reason: 'no workspace' }
    }
    const key = await this.keyOf(event.workspaceId)
    if (!key) {
      return { kind: 'pass', reason: `workspace ${event.workspaceId} is not on this machine` }
    }
    const accountId = this.deps.getRoutes()[key]
    if (!accountId) {
      return { kind: 'pass', reason: `no route for ${key}` }
    }
    const account = this.accounts().find((candidate) => candidate.id === accountId)
    if (!account || !account.exists) {
      const reason = `${displayName(key, this.deps.platform)} 프로젝트에 지정된 Claude 계정(${accountId})을 찾을 수 없습니다. Claude Pin 패널에서 다시 지정하세요.`
      return settings.onMissingAccount === 'deny' ? { kind: 'deny', reason } : { kind: 'pass', reason }
    }
    return { kind: 'route', key, account }
  }

  /** Every local project Orca lists, plus routes whose project is gone, for the panel. */
  async projects(): Promise<ProjectRow[]> {
    const listed = await this.refreshWorkspaces()
    const routes = this.deps.getRoutes()
    const rows = new Map<string, ProjectRow>()
    for (const workspace of listed) {
      const key = await this.repos.keyFor(workspace.path)
      if (!key) {
        continue
      }
      const row = rows.get(key)
      if (row) {
        row.workspaces += 1
      } else {
        rows.set(key, {
          key,
          name: displayName(key, this.deps.platform),
          workspaces: 1,
          accountId: routes[key] ?? null,
          stale: false
        })
      }
    }
    for (const [key, accountId] of Object.entries(routes)) {
      if (!rows.has(key)) {
        rows.set(key, { key, name: displayName(key, this.deps.platform), workspaces: 0, accountId, stale: true })
      }
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
