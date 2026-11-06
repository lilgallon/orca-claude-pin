// Path helpers shared by the worker and its tests. No Orca imports: plain Node only.
import { posix, win32 } from 'node:path'

export type Platform = NodeJS.Platform

function pathApi(platform: Platform) {
  return platform === 'win32' ? win32 : posix
}

/**
 * Orca's userData folder, where it keeps `claude-profiles/<accountId>/home`. Electron names it
 * after the app (`orca`). A worker only inherits HOME and USERPROFILE of these variables, so a
 * redirected APPDATA or XDG_CONFIG_HOME needs the `orcaDataDir` setting.
 */
export function defaultOrcaDataDir(platform: Platform, env: Record<string, string | undefined>): string | null {
  const home = platform === 'win32' ? env.USERPROFILE ?? env.HOME : env.HOME
  if (!home) {
    return null
  }
  const p = pathApi(platform)
  if (platform === 'win32') {
    return p.join(home, 'AppData', 'Roaming', 'orca')
  }
  if (platform === 'darwin') {
    return p.join(home, 'Library', 'Application Support', 'orca')
  }
  return p.join(home, '.config', 'orca')
}

/** One spelling per folder, so routes match whichever separator or case a caller used. */
export function normalizeKey(path: string, platform: Platform): string {
  const p = pathApi(platform)
  let out = p.normalize(platform === 'win32' ? path.replace(/\//g, '\\') : path)
  if (out.length > 1 && (out.endsWith('\\') || out.endsWith('/')) && !/^[A-Za-z]:\\$/.test(out)) {
    out = out.slice(0, -1)
  }
  return platform === 'win32' ? out.toLowerCase() : out
}

/** The folder a `--git-common-dir` names: `<repo>/.git` → `<repo>`; a bare repo is itself. */
export function repoRootFromCommonDir(commonDir: string, platform: Platform): string {
  const p = pathApi(platform)
  const clean = commonDir.trim().replace(/[\\/]+$/, '')
  return p.basename(clean).toLowerCase() === '.git' ? p.dirname(clean) : clean
}

/**
 * The hook names worktrees `<repoId>::<path>` and folder-repo instances
 * `<repoId>::<path>::workspace:<uuid>`; `folder:<id>` carries no path. The format is internal, so
 * this is only a fast path: callers fall back to `workspace.list`, whose ids differ.
 */
export function pathFromWorkspaceId(workspaceId: string): string | null {
  if (workspaceId.startsWith('folder:') || workspaceId.startsWith('identity:')) {
    return null
  }
  const at = workspaceId.indexOf('::')
  if (at <= 0) {
    return null
  }
  const path = workspaceId.slice(at + 2).replace(/::workspace:[^:]+$/, '')
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path) ? path : null
}

/** A WSL path on Windows passes `existsSync`, yet its agents run inside the guest. */
export function isWslPath(path: string, platform: Platform): boolean {
  return platform === 'win32' && /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]/i.test(path)
}

export function displayName(key: string, platform: Platform): string {
  return pathApi(platform).basename(key) || key
}
