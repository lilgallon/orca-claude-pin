// Finds the Claude accounts a route can name: the ones Orca manages (Settings → Accounts) and
// folders the person adds by hand. Plain Node only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type Account = {
  /** Orca's account id (its folder name), or `custom-…` for a hand-added folder. */
  id: string
  label: string
  /** The folder launches get as CLAUDE_CONFIG_DIR. */
  home: string
  source: 'orca' | 'custom'
  exists: boolean
  signedIn: boolean
}

export type CustomAccount = { id: string; label: string; home: string }

type ClaudeJson = { oauthAccount?: { emailAddress?: unknown; organizationName?: unknown } }

/** Who a config folder is signed in as, from Claude Code's own `.claude.json`. */
export function readSignIn(home: string): { email: string | null; org: string | null } {
  try {
    const json = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as ClaudeJson
    const email = typeof json.oauthAccount?.emailAddress === 'string' ? json.oauthAccount.emailAddress : null
    const org =
      typeof json.oauthAccount?.organizationName === 'string' ? json.oauthAccount.organizationName : null
    return { email, org }
  } catch {
    return { email: null, org: null }
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function hasCredentials(home: string): boolean {
  // Windows and Linux keep the login in the folder; macOS keeps it in the Keychain, so a
  // signed-in `.claude.json` counts there too.
  return existsSync(join(home, '.credentials.json')) || readSignIn(home).email !== null
}

function labelFor(home: string, fallback: string): string {
  const { email, org } = readSignIn(home)
  if (!email) {
    return fallback
  }
  return org && !org.includes(email) ? `${email} · ${org}` : email
}

/**
 * Orca's own Claude accounts: `<orcaDataDir>/claude-profiles/<id>/home`, each finished one
 * marked by `profile.json` beside its home. Orca links plugins, skills, settings and session
 * history (`projects/`) into every home, so a route keeps the same setup and resumable sessions.
 */
export function listOrcaAccounts(orcaDataDir: string | null): Account[] {
  if (!orcaDataDir) {
    return []
  }
  const root = join(orcaDataDir, 'claude-profiles')
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return []
  }
  const accounts: Account[] = []
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || id.startsWith('selected-')) {
      continue
    }
    const home = join(root, id, 'home')
    if (!isDir(home) || !existsSync(join(root, id, 'profile.json'))) {
      continue
    }
    accounts.push({
      id,
      label: labelFor(home, `Orca 계정 ${id.slice(0, 8)} (로그인 없음)`),
      home,
      source: 'orca',
      exists: true,
      signedIn: hasCredentials(home)
    })
  }
  return accounts.sort((a, b) => a.label.localeCompare(b.label))
}

export function describeCustom(custom: CustomAccount): Account {
  const exists = isDir(custom.home)
  return {
    id: custom.id,
    label: custom.label || labelFor(custom.home, custom.home),
    home: custom.home,
    source: 'custom',
    exists,
    signedIn: exists && hasCredentials(custom.home)
  }
}

export function parseCustomAccounts(value: unknown): CustomAccount[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const { id, label, home } = item as Record<string, unknown>
    return typeof id === 'string' && typeof home === 'string'
      ? [{ id, label: typeof label === 'string' ? label : '', home }]
      : []
  })
}

export function parseRoutes(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, accountId] of Object.entries(value)) {
    if (typeof accountId === 'string' && accountId) {
      out[key] = accountId
    }
  }
  return out
}
