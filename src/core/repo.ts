// Which project a workspace belongs to: the main repository behind a Git worktree, or the
// folder itself. Results are cached, because the launch hook has a 2 s budget.
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { normalizeKey, repoRootFromCommonDir, type Platform } from './paths.ts'

export type KeyResult =
  | { kind: 'key'; key: string }
  /** The path is not on this machine: a remote workspace or an unmounted volume. */
  | { kind: 'absent' }
  /** Git could not answer, so the project is not known. Never cached. */
  | { kind: 'unknown'; reason: string }

type GitAnswer = { kind: 'repo'; commonDir: string } | { kind: 'not-repo' } | { kind: 'failed'; reason: string }

function askGit(cwd: string, timeoutMs: number): Promise<GitAnswer> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      // Git translates its messages, and the one below decides what a failure means.
      { timeout: timeoutMs, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        // Git before 2.31 echoes the unknown flag above the path and answers relative to cwd.
        const line = String(stdout).trim().split('\n').pop()?.trim()
        if (!error && line && !line.startsWith('--')) {
          resolve({ kind: 'repo', commonDir: isAbsolute(line) ? line : resolvePath(cwd, line) })
        } else if (error?.code === 128 && /not a git repository \(or any/i.test(String(stderr))) {
          // "not a git repository: <path>" is different: a worktree whose main repo is unreachable.
          resolve({ kind: 'not-repo' })
        } else {
          resolve({ kind: 'failed', reason: error?.message ?? 'git printed nothing' })
        }
      }
    )
  })
}

export class RepoResolver {
  private readonly cache = new Map<string, string>()
  private readonly platform: Platform
  private readonly gitTimeoutMs: number

  constructor(platform: Platform, gitTimeoutMs = 1500) {
    this.platform = platform
    this.gitTimeoutMs = gitTimeoutMs
  }

  async keyFor(path: string): Promise<KeyResult> {
    const cached = this.cache.get(path)
    if (cached) {
      return { kind: 'key', key: cached }
    }
    if (!existsSync(path)) {
      return { kind: 'absent' }
    }
    const answer = await askGit(path, this.gitTimeoutMs)
    if (answer.kind === 'failed') {
      // Falling back to the path here would miss the project's pin and start the wrong account.
      return { kind: 'unknown', reason: answer.reason }
    }
    if (answer.kind === 'not-repo') {
      // Not cached: `git init` can change the answer. Real path, as git gives for repositories.
      return { kind: 'key', key: normalizeKey(realpathSync.native(path), this.platform) }
    }
    const key = normalizeKey(repoRootFromCommonDir(answer.commonDir, this.platform), this.platform)
    this.cache.set(path, key)
    return { kind: 'key', key }
  }

  forget(path: string): void {
    this.cache.delete(path)
  }
}
