// The panel ↔ worker contract, declared once for src/panel.tsx and src/worker.ts.
export {}

export type AccountView = {
  id: string
  label: string
  home: string
  source: 'orca' | 'custom'
  exists: boolean
  signedIn: boolean
}

export type UsageWindowView = { label: string; percent: number; resetsAt: number | null }

export type AccountUsageView =
  | { status: 'ok'; windows: UsageWindowView[]; checkedAt: number }
  | { status: 'expired' | 'unavailable' | 'rate-limited'; message: string; checkedAt: number }

export type ProjectView = {
  key: string
  name: string
  workspaces: number
  accountId: string | null
  stale: boolean
  /** Why this project's pin cannot apply right now. */
  problem: string | null
}

export type PanelState = {
  accounts: AccountView[]
  projects: ProjectView[]
  orcaDataDir: string | null
  agents: string[]
  /** The account Orca's selection points at; null means System default. */
  selectedHome: string | null
  platform: string
  onPinFailure: 'deny' | 'pass'
  /** By account id. Null until the person turns usage on. */
  usage: Record<string, AccountUsageView> | null
  /** The language the worker wrote every text in; the panel follows it. */
  lang: 'en' | 'fr'
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    /** `locale` is Orca's UI language, which only the panel can read. */
    'state.get': { input: { locale?: string }; output: PanelState }
    'route.set': { input: { key: string; accountId: string | null }; output: PanelState }
    'custom.add': { input: { label: string; home: string }; output: PanelState }
    'custom.remove': { input: { id: string }; output: PanelState }
    'usage.refresh': { input: Record<string, never>; output: PanelState }
    'usage.setEnabled': { input: { enabled: boolean }; output: PanelState }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    'state.changed': Record<string, never>
  }
}
