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

export type ProjectView = {
  key: string
  name: string
  workspaces: number
  accountId: string | null
  stale: boolean
}

export type PanelState = {
  accounts: AccountView[]
  projects: ProjectView[]
  orcaDataDir: string | null
  agents: string[]
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    'state.get': { input: Record<string, never>; output: PanelState }
    'route.set': { input: { key: string; accountId: string | null }; output: PanelState }
    'custom.add': { input: { label: string; home: string }; output: PanelState }
    'custom.remove': { input: { id: string }; output: PanelState }
  }
}
