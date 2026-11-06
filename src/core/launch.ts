// Builds the command line that pins an account. Plain Node only.
//
// Orca overwrites a hook's CLAUDE_CONFIG_DIR with the selected account's after the hook runs, and
// its `claude` shell function then re-reads the selection. A value set by the command itself is
// kept, unless it equals the user's own folder, which ORCA_CLAUDE_USER_CONFIG_DIR records, so that
// marker is blanked as well. See docs/DESIGN.md.

const USER_MARKER = 'ORCA_CLAUDE_USER_CONFIG_DIR'
/** Orca's wrapper when a launch waits for a setup script (src/shared/setup-agent-sequencing.ts). */
const SEQUENCED_LAUNCH = /^bash -lc '(eval "\$ORCA_[A-Z0-9_]+")'$/
const SEQUENCED_COMMAND = 'ORCA_SEQUENCED_STARTUP_COMMAND'
const BARE_CLAUDE = /^claude(?=\s|$)/

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const withoutSingleQuoted = (command: string): string => command.replace(/'[^']*'/g, '')

/** Whether something after the first command would escape an assignment prefix. */
function hasSeparator(command: string): boolean {
  return /[;&|()`\n]/.test(withoutSingleQuoted(command).replace(/"(?:[^"\\]|\\.)*"/g, ''))
}

/**
 * - A lone bare `claude` keeps the prefix form Orca's parser reads, so it still adds `--plugin-dir`.
 *   Quoting the word skips the user's alias, whose `&&` would otherwise end the prefix's reach,
 *   and still reaches Orca's function.
 * - Anything else assigns first, which reaches the whole line.
 * - The setup wrapper's login shell reads the user's profile, so the assignment goes inside it.
 *
 * A shell that rejects these forms (tcsh, fish for the second) stops with an error at the first
 * word rather than going on to start the selected account, which is why `&&` joins them.
 */
export function pinnedCommand(command: string, home: string): string {
  const value = shellQuote(home)
  const assign = `${USER_MARKER}= && export CLAUDE_CONFIG_DIR=${value} &&`
  const sequenced = SEQUENCED_LAUNCH.exec(command)
  if (sequenced) {
    // The hook cannot see the real command here, so its own assignment is caught as it runs.
    const guard = `case "$${SEQUENCED_COMMAND}" in *CLAUDE_CONFIG_DIR=*) echo 'Claude Pin: the Claude command sets CLAUDE_CONFIG_DIR itself' >&2; exit 1;; esac;`
    return `bash -lc ${shellQuote(`${guard} ${assign} ${sequenced[1]}`)}`
  }
  if (BARE_CLAUDE.test(command) && !hasSeparator(command)) {
    return `${USER_MARKER}= CLAUDE_CONFIG_DIR=${value} ${command.replace(BARE_CLAUDE, "'claude'")}`
  }
  return `${assign} ${command}`
}

/** A later assignment would beat the pin. Single quotes are how Orca passes a launch prompt. */
export function assignsConfigDir(command: string): boolean {
  return /\bCLAUDE_CONFIG_DIR=/.test(withoutSingleQuoted(command))
}
