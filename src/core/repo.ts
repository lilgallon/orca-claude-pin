// Which project a workspace belongs to: the main repository behind a Git worktree, or the
// folder itself. Results are cached, because the launch hook has a 2 s budget.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { normalizeKey, repoRootFromCommonDir, type Platform } from './paths.ts'

export type KeyResult =
  | { kind: 'key'; key: string }
  /** The path is not on this machine: a remote workspace or an unmounted volume. */
  | { kind: 'absent' }
  /** Git could not answer, so the project is not known. Never cached. */
  | { kind: 'unknown'; reason: string }

type GitAnswer =
  | { kind: 'repo'; gitDir: string; commonDir: string }
  | { kind: 'not-repo' }
  | { kind: 'failed'; reason: string }

function askGit(cwd: string, timeoutMs: number): Promise<GitAnswer> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      // Git translates its messages, and the one below decides what a failure means.
      { timeout: timeoutMs, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        // Git before 2.31 echoes the unknown flag above the paths and answers relative to cwd.
        const [gitDir, commonDir] = String(stdout)
          .trim()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('--'))
          .map((line) => (isAbsolute(line) ? line : resolvePath(cwd, line)))
        if (!error && gitDir && commonDir) {
          resolve({ kind: 'repo', gitDir, commonDir })
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

function isWithin(root: string, path: string): boolean {
  const down = relative(realpathSync.native(root), realpathSync.native(path))
  return down === '' || (!down.startsWith('..') && !isAbsolute(down))
}

/**
 * A `.git` file can name any repository, so a folder could otherwise claim a pinned project's
 * account and its folder trust. A real worktree is named back by its entry in the repository.
 */
function claimsItsRepository(path: string, gitDir: string, commonDir: string, platform: Platform): 'yes' | 'foreign' | 'stale' {
  try {
    if (realpathSync.native(gitDir) === realpathSync.native(commonDir)) {
      // A submodule or --separate-git-dir also lands here: its own project, keyed by its folder.
      return isWithin(repoRootFromCommonDir(commonDir, platform), path) ? 'yes' : 'foreign'
    }
    if (dirname(realpathSync.native(gitDir)) !== join(realpathSync.native(commonDir), 'worktrees')) {
      return 'stale'
    }
    const backLink = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()
    return isWithin(dirname(resolvePath(gitDir, backLink)), path) ? 'yes' : 'stale'
  } catch {
    return 'stale'
  }
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
    const claim = claimsItsRepository(path, answer.gitDir, answer.commonDir, this.platform)
    if (claim === 'foreign') {
      return { kind: 'key', key: normalizeKey(realpathSync.native(path), this.platform) }
    }
    if (claim === 'stale') {
      // A moved worktree looks the same as a forged one, and either way the project is not known.
      return { kind: 'unknown', reason: '워크트리가 레포에 등록된 위치와 다릅니다. git worktree repair를 실행하세요.' }
    }
    const key = normalizeKey(repoRootFromCommonDir(answer.commonDir, this.platform), this.platform)
    this.cache.set(path, key)
    return { kind: 'key', key }
  }

  forget(path: string): void {
    this.cache.delete(path)
  }
}
