// Which project a workspace belongs to: the main repository behind a Git worktree, or the
// folder itself. Results are cached, because the launch hook has a 2 s budget.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { normalizeKey, repoRootFromCommonDir, type Platform } from './paths.ts'

function gitCommonDir(cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null)
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

  /** The project key for a local path, or null when the path is not on this machine. */
  async keyFor(path: string): Promise<string | null> {
    const cached = this.cache.get(path)
    if (cached) {
      return cached
    }
    if (!existsSync(path)) {
      // An SSH or WSL workspace: its path names another machine's disk.
      return null
    }
    const commonDir = await gitCommonDir(path, this.gitTimeoutMs)
    const key = normalizeKey(commonDir ? repoRootFromCommonDir(commonDir, this.platform) : path, this.platform)
    this.cache.set(path, key)
    return key
  }

  forget(path: string): void {
    this.cache.delete(path)
  }
}
