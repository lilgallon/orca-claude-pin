// Each account's plan usage, read the way Orca reads it for its own usage bar: the account's stored
// access token, sent only to Anthropic's usage endpoint. The plugin API offers no usage data.
//
// The token stays in the call that reads it: it is never returned, logged or stored. It is never
// refreshed either, because only Claude Code may rotate its tokens; an expired one is reported.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import { join } from 'node:path'
import tls from 'node:tls'

export type UsageWindow = { label: string; percent: number; resetsAt: number | null }

export type AccountUsage =
  | { status: 'ok'; windows: UsageWindow[]; checkedAt: number }
  | { status: 'expired' | 'unavailable' | 'rate-limited'; message: string; checkedAt: number }

type RawWindow = { utilization?: unknown; resets_at?: unknown }
type RawLimit = { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } | null } | null }
type RawUsage = { five_hour?: RawWindow | null; seven_day?: RawWindow | null; limits?: RawLimit[] | null }

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 1024 * 1024
const KEYCHAIN_TIMEOUT_MS = 3000
/** Orca polls each account no more than this; the endpoint rate limits. */
const FRESH_MS = 5 * 60_000
/** The refresh button's floor, as Orca keeps for its own account list. */
const FORCED_FRESH_MS = 60_000
const DEFAULT_RETRY_AFTER_MS = 5 * 60_000
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000
/** Separates plausible epoch seconds (before 2286) from milliseconds, as Orca does. */
const EPOCH_SECONDS_LIMIT = 10_000_000_000

function toWindow(label: string, percent: unknown, resetsAt: unknown): UsageWindow | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return null
  }
  return { label, percent: Math.min(100, Math.max(0, percent)), resetsAt: parseReset(resetsAt) }
}

function parseReset(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }
  const numeric = Number(value)
  if (value !== '' && Number.isFinite(numeric)) {
    return numeric > EPOCH_SECONDS_LIMIT ? numeric : numeric * 1000
  }
  const at = new Date(value).getTime()
  return Number.isNaN(at) ? null : at
}

/** Seconds or an HTTP date; polling early only prolongs a rate limit. */
function parseRetryAfter(value: string | undefined, now: number): number {
  const seconds = Number(value)
  const delay = value && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? '') - now
  return delay > 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : DEFAULT_RETRY_AFTER_MS
}

/** The windows a plan has. `spend` is left out: it is overage or a team budget, not a usage limit. */
export function parseUsageWindows(body: unknown): UsageWindow[] {
  if (typeof body !== 'object' || body === null) {
    return []
  }
  const raw = body as RawUsage
  const scoped = (Array.isArray(raw.limits) ? raw.limits : [])
    .filter((limit) => limit?.kind === 'weekly_scoped' && typeof limit.scope?.model?.display_name === 'string')
    .map((limit) => toWindow(`주간 (${String(limit.scope?.model?.display_name)})`, limit.percent, limit.resets_at))
  const windows = [
    toWindow('5시간', raw.five_hour?.utilization, raw.five_hour?.resets_at),
    toWindow('주간', raw.seven_day?.utilization, raw.seven_day?.resets_at),
    ...scoped
  ].filter((window) => window !== null)
  // The label is the panel's key, and Orca refuses to draw a duplicate key.
  return windows.filter((window, index) => windows.findIndex((other) => other.label === window.label) === index)
}

export function usageFromResponse(
  status: number,
  body: string,
  retryAfter: string | undefined,
  checkedAt: number
): AccountUsage & { retryAfterMs?: number } {
  if (status === 401) {
    return { status: 'expired', message: '토큰이 만료되었습니다. 이 계정으로 Claude를 한 번 실행하면 갱신됩니다.', checkedAt }
  }
  if (status === 429) {
    return {
      status: 'rate-limited',
      message: '사용량 요청이 잠시 제한되었습니다.',
      checkedAt,
      retryAfterMs: parseRetryAfter(retryAfter, checkedAt)
    }
  }
  if (status !== 200) {
    return { status: 'unavailable', message: `사용량 서버가 ${status}로 응답했습니다.`, checkedAt }
  }
  try {
    const windows = parseUsageWindows(JSON.parse(body))
    return windows.length > 0
      ? { status: 'ok', windows, checkedAt }
      : { status: 'unavailable', message: '이 계정에는 표시할 사용량 한도가 없습니다.', checkedAt }
  } catch {
    return { status: 'unavailable', message: '사용량 응답을 읽지 못했습니다.', checkedAt }
  }
}

function tokenFromCredentials(json: string): string | null {
  try {
    const token = (JSON.parse(json) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth?.accessToken
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

/** Claude Code names the item after the exact spelling of the config folder. */
export function keychainService(home: string): string {
  const suffix = createHash('sha256').update(home.normalize('NFC')).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

function readKeychain(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : tokenFromCredentials(String(stdout)))
    )
  })
}

/** The spelling used at login names the item, so also try the real path, as Orca does. */
function spellings(home: string): string[] {
  try {
    return [...new Set([home, realpathSync.native(home)])]
  } catch {
    return [home]
  }
}

async function readToken(home: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    for (const spelling of spellings(home)) {
      const token = await readKeychain(keychainService(spelling))
      if (token) {
        return token
      }
    }
  }
  try {
    return tokenFromCredentials(await readFile(join(home, '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

let trustRoots: string[] | undefined
/**
 * A worker inherits no NODE_EXTRA_CA_CERTS, so without the OS store a network that inspects TLS
 * fails every request. Orca itself goes through Chromium, which uses the OS store.
 */
function caCertificates(): string[] | undefined {
  try {
    trustRoots ??= [...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')]
  } catch {
    return undefined
  }
  return trustRoots
}

export function requestUsage(
  token: string,
  get: typeof https.get = https.get,
  url: string = USAGE_URL
): Promise<{ status: number; body: string; retryAfter?: string }> {
  return new Promise((resolve, reject) => {
    const req = get(
      url,
      {
        ca: caCertificates(),
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-pin' }
      },
      (response) => {
        let body = ''
        // A connection closed mid-body reports only here; missing it would never settle.
        response.on('error', reject)
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
          if (body.length > MAX_BODY_BYTES) {
            req.destroy(new Error('response too large'))
          }
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body, retryAfter: response.headers['retry-after'] })
        )
      }
    )
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
  })
}

export async function fetchAccountUsage(home: string, now: () => number = Date.now): Promise<AccountUsage & { retryAfterMs?: number }> {
  const token = await readToken(home)
  if (!token) {
    return { status: 'unavailable', message: '저장된 로그인 토큰을 찾지 못했습니다.', checkedAt: now() }
  }
  try {
    const { status, body, retryAfter } = await requestUsage(token)
    return usageFromResponse(status, body, retryAfter, now())
  } catch (error) {
    // Only the code: nothing from the request reaches the panel or the log.
    const code = (error as NodeJS.ErrnoException).code ?? 'network'
    return { status: 'unavailable', message: `사용량 서버에 연결하지 못했습니다 (${code}).`, checkedAt: now() }
  }
}

type Asked = { id: string; home: string }
type Fetch = (home: string) => Promise<AccountUsage & { retryAfterMs?: number }>

/** Remembers usage per account and asks one account at a time, no more often than Orca does. */
export class UsageTracker {
  private readonly known = new Map<string, AccountUsage>()
  private readonly retryAt = new Map<string, number>()
  private running: Promise<boolean> | null = null
  private forceAfter = false
  private readonly fetchUsage: Fetch
  private readonly now: () => number

  constructor(fetchUsage: Fetch = fetchAccountUsage, now: () => number = Date.now) {
    this.fetchUsage = fetchUsage
    this.now = now
  }

  snapshot(ids: readonly string[]): Record<string, AccountUsage> {
    const out: Record<string, AccountUsage> = {}
    for (const id of ids) {
      const usage = this.known.get(id)
      if (usage) {
        out[id] = usage
      }
    }
    return out
  }

  /**
   * Resolves true when anything was asked, so a caller can tell open panels. Never rejects.
   * `stillWanted` is checked before each account, because a run can take a while.
   */
  refresh(accounts: readonly Asked[], options: { force?: boolean; stillWanted?: (id: string) => boolean } = {}): Promise<boolean> {
    if (this.running) {
      // The person pressed refresh during a plain run: honour it once that run ends.
      this.forceAfter ||= options.force ?? false
      return this.running
    }
    const { force = false, stillWanted = () => true } = options
    this.running = this.run(accounts, force, stillWanted)
      .then(async (asked) => {
        const again = this.forceAfter
        this.forceAfter = false
        return again ? (await this.run(accounts, true, stillWanted)) || asked : asked
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async run(accounts: readonly Asked[], force: boolean, stillWanted: (id: string) => boolean): Promise<boolean> {
    const freshMs = force ? FORCED_FRESH_MS : FRESH_MS
    let asked = false
    for (const { id, home } of accounts) {
      const last = this.known.get(id)
      if ((last && this.now() - last.checkedAt < freshMs) || this.now() < (this.retryAt.get(id) ?? 0) || !stillWanted(id)) {
        continue
      }
      asked = true
      const { retryAfterMs, ...usage } = await this.fetchUsage(home)
      this.known.set(id, usage)
      if (retryAfterMs) {
        this.retryAt.set(id, this.now() + retryAfterMs)
      }
    }
    return asked
  }
}
