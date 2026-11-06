// Marks a workspace as trusted in a pinned account, as Orca does for the selected one.
//
// Orca writes trust to the selected account's file, so a pinned account would otherwise stop every
// new worktree at Claude's trust prompt, whose default answer exits. Same file format and locking
// as Orca's claude-folder-trust-file.ts: Claude locks `<file>.lock` with a directory.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, normalize, relative, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { claudeStateFile } from './accounts.ts'

export type TrustOutcome = 'granted' | 'unchanged' | 'missing-config' | 'locked' | 'unreadable' | 'too-broad'

const LOCK_ATTEMPTS = 5
const LOCK_WAIT_MS = 50

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Claude looks a folder up by its NFC normalized path, `/` separated on Windows. */
function trustKeys(workspacePath: string): string[] {
  const forms = [resolve(workspacePath)]
  try {
    forms.push(realpathSync.native(workspacePath))
  } catch {
    // The resolved form alone still matches an unsymlinked path.
  }
  const keys = forms.map((form) => {
    const key = normalize(form.normalize('NFC'))
    return process.platform === 'win32' ? key.replaceAll('\\', '/') : key
  })
  return [...new Set(keys)]
}

/** Claude applies a folder's trust to what lies below it, so home and root must never get it. */
function isTooBroad(folder: string, home: string): boolean {
  if (dirname(folder) === folder) {
    return true
  }
  const down = relative(folder, home)
  return down === '' || (!down.startsWith('..') && !isAbsolute(down))
}

function readConfig(file: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(parsed) && (parsed.projects === undefined || isObject(parsed.projects)) ? parsed : null
  } catch {
    return null
  }
}

function isTrusted(config: Json, keys: string[]): boolean {
  const projects = (config.projects ?? {}) as Json
  return keys.some((key) => {
    const entry = projects[key]
    return isObject(entry) && entry.hasTrustDialogAccepted === true
  })
}

function withTrust(config: Json, keys: string[]): Json {
  const projects = { ...((config.projects ?? {}) as Json) }
  for (const key of keys) {
    const entry = projects[key]
    projects[key] = isObject(entry) ? { ...entry, hasTrustDialogAccepted: true } : { hasTrustDialogAccepted: true }
  }
  return { ...config, projects }
}

async function acquire(lockPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lockPath)
      return true
    } catch {
      await sleep(LOCK_WAIT_MS)
    }
  }
  return false
}

export async function grantFolderTrust(home: string, workspacePath: string): Promise<TrustOutcome> {
  const file = claudeStateFile(home)
  if (!existsSync(file)) {
    return 'missing-config'
  }
  const keys = trustKeys(workspacePath)
  if (keys.some((key) => isTooBroad(key, homedir()))) {
    return 'too-broad'
  }
  const first = readConfig(file)
  if (!first) {
    return 'unreadable'
  }
  if (isTrusted(first, keys)) {
    return 'unchanged'
  }
  const lockPath = `${file}.lock`
  if (!(await acquire(lockPath))) {
    return 'locked'
  }
  try {
    // Stay synchronous from here to the rename, so Claude's own writer cannot interleave.
    const current = readConfig(file)
    if (!current) {
      return 'unreadable'
    }
    if (isTrusted(current, keys)) {
      return 'unchanged'
    }
    const target = realpathSync(file)
    const temp = `${target}.claude-pin-${randomUUID()}.tmp`
    const mode = statSync(target).mode & 0o777
    try {
      writeFileSync(temp, `${JSON.stringify(withTrust(current, keys), null, 2)}\n`, { flag: 'wx', mode })
      if (process.platform !== 'win32') {
        // Restore bits narrowed by umask.
        chmodSync(temp, mode)
      }
      renameSync(temp, target)
    } finally {
      // Gone after a successful rename; otherwise each launch would leave another copy.
      rmSync(temp, { force: true })
    }
    return 'granted'
  } finally {
    rmdirSync(lockPath)
  }
}
