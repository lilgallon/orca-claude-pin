// Finds the Claude accounts a route can name: the ones Orca manages (Settings → Accounts) and
// folders the person adds by hand. Plain Node only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { messages, type Messages } from './i18n.ts'

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

const ORCA_ACCOUNT_ID = /^[a-zA-Z0-9_-]+$/

/** Claude Code's state file in a config folder; it prefers a non-empty legacy `.config.json`. */
export function claudeStateFile(home: string): string {
  const legacy = join(home, '.config.json')
  try {
    if (statSync(legacy).size > 0) {
      return legacy
    }
  } catch {
    // No legacy file, the usual case.
  }
  return join(home, '.claude.json')
}

/** Who a config folder is signed in as, from Claude Code's own state file. */
export function readSignIn(home: string): { email: string | null; org: string | null } {
  try {
    const json = JSON.parse(readFileSync(claudeStateFile(home), 'utf8')) as ClaudeJson
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
  // signed-in `.claude.json` counts there too. This cannot tell a revoked login from a good one.
  return existsSync(join(home, '.credentials.json')) || readSignIn(home).email !== null
}

function labelFor(home: string, fallback: string): string {
  const { email, org } = readSignIn(home)
  if (!email) {
    return fallback
  }
  return org && !org.includes(email) ? `${email} · ${org}` : email
}

/** `profile.json` is written last by Orca's setup; `wsl` homes live inside the guest. */
function isFinishedHostProfile(profileDir: string): boolean {
  try {
    const profile = JSON.parse(readFileSync(join(profileDir, 'profile.json'), 'utf8')) as { runtime?: unknown }
    return profile.runtime !== 'wsl'
  } catch {
    return false
  }
}

function describeOrcaAccount(root: string, id: string, t: Messages): Account | null {
  if (!ORCA_ACCOUNT_ID.test(id) || id.startsWith('selected-')) {
    return null
  }
  const profileDir = join(root, id)
  const home = join(profileDir, 'home')
  if (!isDir(home) || !isFinishedHostProfile(profileDir)) {
    return null
  }
  return {
    id,
    label: labelFor(home, t.orcaAccountSignedOut(id.slice(0, 8))),
    home,
    source: 'orca',
    exists: true,
    signedIn: hasCredentials(home)
  }
}

/**
 * Orca's own Claude accounts: `<orcaDataDir>/claude-profiles/<id>/home`. The plugin API offers no
 * account list, so this reads the folders. Orca links plugins, skills, settings and session
 * history (`projects/`) into every home, so a route keeps the same setup and resumable sessions.
 */
export function listOrcaAccounts(orcaDataDir: string | null, t: Messages = messages('en')): Account[] {
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
  return ids
    .flatMap((id) => describeOrcaAccount(root, id, t) ?? [])
    .sort((a, b) => a.label.localeCompare(b.label))
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

/** One account by id, without reading every other account's `.claude.json` during a launch. */
export function findAccount(
  id: string,
  orcaDataDir: string | null,
  customAccounts: readonly CustomAccount[],
  t: Messages = messages('en')
): Account | null {
  const custom = customAccounts.find((account) => account.id === id)
  if (custom) {
    return describeCustom(custom)
  }
  return orcaDataDir ? describeOrcaAccount(join(orcaDataDir, 'claude-profiles'), id, t) : null
}

/**
 * The home Orca's `claude` shell function uses in this machine's terminals, from the pointer file
 * it reads on every launch. Null means the System default login (an empty or missing file);
 * undefined means the file could not be read, so the selection is not known.
 */
export function readSelectedHome(orcaDataDir: string | null): string | null | undefined {
  if (!orcaDataDir || !isDir(orcaDataDir)) {
    return undefined
  }
  try {
    return readFileSync(join(orcaDataDir, 'claude-profiles', 'selected-host'), 'utf8').trim() || null
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
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
