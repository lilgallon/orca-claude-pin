// Claude Pin panel: pick an account per project. The worker owns the data; this only asks.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Collapsible,
  Code,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  type PanelContext
} from 'orca'
import type { AccountUsageView, AccountView, PanelState, ProjectView } from './protocol'

const state = atom<PanelState | null>(null)
const failure = atom<string | null>(null)
const busy = atom(false)
const customLabel = atom('customLabel', '')
const customHome = atom('customHome', '')

const ORCA_DEFAULT = '__orca_default__'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function run(task: () => Promise<PanelState>): Promise<void> {
  set(busy, true)
  try {
    set(state, await task())
    set(failure, null)
  } catch (error) {
    set(failure, message(error))
  } finally {
    set(busy, false)
  }
}

const refresh = () => run(() => plugin.request('state.get', {}, { timeoutMs: 15000 }))
const refreshWithUsage = () => run(() => plugin.request('usage.refresh', {}, { timeoutMs: 15000 }))

function setRoute(key: string, value: string): Promise<void> {
  return run(() =>
    plugin.request('route.set', { key, accountId: value === ORCA_DEFAULT ? null : value })
  )
}

function addCustom(): Promise<void> {
  const home = read(customHome).trim()
  if (!home) {
    return Promise.resolve()
  }
  return run(async () => {
    const next = await plugin.request('custom.add', { label: read(customLabel), home })
    set(customLabel, '')
    set(customHome, '')
    return next
  })
}

export function setup(ctx: PanelContext): void {
  void refresh()
  ctx.subscriptions.push(plugin.on('state.changed', () => void refresh()))
}

function accountOptions(accounts: AccountView[], current: string | null) {
  const options = [
    { value: ORCA_DEFAULT, label: 'Orca default (globally selected account)' },
    ...accounts.map((account) => ({
      value: account.id,
      label: `${account.label}${account.source === 'custom' ? ' · added by hand' : ''}${
        !account.exists ? ' (folder missing)' : !account.signedIn ? ' (sign-in needed)' : ''
      }`
    }))
  ]
  if (current && !accounts.some((account) => account.id === current)) {
    options.push({ value: current, label: `Unknown account ${current}` })
  }
  return options
}

/** One line for a project card; the account list has the detail. */
function usageSummary(usage: AccountUsageView | undefined): string | null {
  if (!usage) {
    return null
  }
  return usage.status === 'ok'
    ? usage.windows.map((window) => `${window.label} ${Math.round(window.percent)}%`).join(' · ')
    : usage.message
}

function UsageDetail({ usage }: { usage: AccountUsageView | undefined }) {
  if (!usage) {
    return (
      <Text muted size="xs">
        Checking usage
      </Text>
    )
  }
  if (usage.status !== 'ok') {
    return (
      <Text size="xs" tone={usage.status === 'expired' ? 'warning' : undefined} muted={usage.status !== 'expired'}>
        {usage.message}
      </Text>
    )
  }
  return (
    <Stack gap="xs">
      {usage.windows.map((window) => (
        <Stack key={window.label} gap="none">
          <Row justify="between" gap="xs">
            <Text size="xs">
              {window.label} {Math.round(window.percent)}%
            </Text>
            {window.resetsAt ? (
              <Text muted size="xs">
                resets <RelativeTime at={window.resetsAt} />
              </Text>
            ) : null}
          </Row>
          <Progress label={`${window.label} usage`} labelHidden value={window.percent} />
        </Stack>
      ))}
      <Text muted size="xs">
        checked <RelativeTime at={usage.checkedAt} />
      </Text>
    </Stack>
  )
}

function manualCommand(platform: string, home: string): string {
  return platform === 'win32'
    ? `$env:CLAUDE_CONFIG_DIR="${home}"; claude`
    : `ORCA_CLAUDE_USER_CONFIG_DIR= CLAUDE_CONFIG_DIR='${home.replace(/'/g, `'\\''`)}' 'claude'`
}

function ProjectCard({ project, current }: { project: ProjectView; current: PanelState }) {
  const { problem } = project
  const account = current.accounts.find((candidate) => candidate.id === project.accountId)
  return (
    <Card
      title={project.name}
      description={project.stale ? 'Project no longer listed in Orca' : `${project.workspaces} workspace${project.workspaces === 1 ? '' : 's'}`}
    >
      <Stack gap="xs">
        <Select
          label={`${project.name} account`}
          labelHidden
          value={project.accountId ?? ORCA_DEFAULT}
          options={accountOptions(current.accounts, project.accountId)}
          disabled={read(busy)}
          onChange={(value) => void setRoute(project.key, value)}
        />
        {problem ? (
          <Text tone="danger" size="sm">
            {problem}{' '}
            {current.onPinFailure === 'deny'
              ? 'Until this is fixed, new Claude launches in this project will be refused.'
              : 'Until this is fixed, new Claude launches in this project run with the account selected in Orca.'}
          </Text>
        ) : null}
        <Text muted size="xs" truncate>
          {project.key}
        </Text>
        {account && !problem && current.usage && usageSummary(current.usage[account.id]) ? (
          <Text muted size="xs">
            {usageSummary(current.usage[account.id])}
          </Text>
        ) : null}
        {account && !problem ? (
          <Collapsible title="To run it directly in a terminal">
            <Stack gap="xs">
              <Text muted size="xs">
                The pin does not apply to claude typed by hand. Use this command:
              </Text>
              <Code block>{manualCommand(current.platform, account.home)}</Code>
            </Stack>
          </Collapsible>
        ) : null}
      </Stack>
    </Card>
  )
}

function AccountsSection({ current }: { current: PanelState }) {
  const { accounts, platform, usage } = current
  const examplePath = platform === 'win32' ? 'C:\\Users\\me\\.claude-work' : '/Users/me/.claude-work'
  const loginCommand =
    platform === 'win32'
      ? '$env:CLAUDE_CONFIG_DIR="<folder>"; claude   # then /login'
      : "CLAUDE_CONFIG_DIR='<folder>' claude   # then /login"
  return (
    <Collapsible title="Accounts and usage" description={`${accounts.length}`} defaultOpen>
      <Stack gap="sm">
        {accounts.length === 0 ? (
          <Text muted size="sm">
            Claude accounts you add in Orca Settings → Accounts appear here.
          </Text>
        ) : null}
        {accounts.map((account) => (
          <Stack key={account.id} gap="xs">
            <Row justify="between" gap="xs">
              <Stack gap="none">
                <Row gap="xs" wrap>
                  <Text size="sm" weight="medium" truncate>
                    {account.label}
                  </Text>
                  {account.home === current.selectedHome ? <Badge tone="accent">Orca selection</Badge> : null}
                  {account.signedIn ? null : (
                    <Badge tone="warning">{account.exists ? 'Sign-in needed' : 'Folder missing'}</Badge>
                  )}
                </Row>
                <Text muted size="xs" truncate>
                  {account.home}
                </Text>
              </Stack>
              {account.source === 'custom' ? (
                <IconButton
                  icon="delete"
                  label="Remove this account folder"
                  variant="ghost"
                  onPress={() => void run(() => plugin.request('custom.remove', { id: account.id }))}
                />
              ) : null}
            </Row>
            {usage && account.signedIn ? <UsageDetail usage={usage[account.id]} /> : null}
          </Stack>
        ))}
        <Switch
          label="Show each account's usage"
          checked={usage !== null}
          disabled={read(busy)}
          onChange={(enabled) => void run(() => plugin.request('usage.setEnabled', { enabled }))}
        />
        <Text muted size="xs">
          When on, while the panel is open, reads each account's stored login token and asks Anthropic's usage
          API, the same way as Orca's usage bar. The token is used only for this request and is never stored.
        </Text>
        <Text weight="medium" size="sm">
          Add an account folder by hand
        </Text>
        <Text muted size="xs">
          Sign in with that folder first. Orca's status display and shared settings apply only to Orca accounts.
        </Text>
        <Code block>{loginCommand}</Code>
        <Input label="Name" placeholder="e.g. Work account" value={read(customLabel)} onChange={(v) => set(customLabel, v)} />
        <Input
          label="CLAUDE_CONFIG_DIR folder"
          placeholder={examplePath}
          value={read(customHome)}
          onChange={(v) => set(customHome, v)}
          onSubmit={() => void addCustom()}
        />
        <Button icon="add" variant="outline" disabled={!read(customHome).trim() || read(busy)} onPress={() => void addCustom()}>
          Add
        </Button>
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const current = read(state)
  const error = read(failure)
  const selected = current?.accounts.find((account) => account.home === current.selectedHome)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Claude Pin</Heading>
        <IconButton icon="refresh" label="Refresh" variant="ghost" disabled={read(busy)} onPress={() => void refreshWithUsage()} />
      </Row>
      {error ? (
        <Callout tone="danger" title="The request could not be processed">
          {error}
        </Callout>
      ) : null}
      {!current ? (
        <Spinner label="Loading" />
      ) : (
        <Stack gap="md">
          <Text muted size="sm">
            Applies to newly opened Claude terminals. Restored or resumed sessions, native chat, claude typed by hand,
            and launches right after Orca starts use the account selected in Orca ({selected?.label ?? (current.selectedHome ?? 'System default')}).
          </Text>
          {current.projects.length === 0 ? (
            <EmptyState icon="folder" title="No projects" description="Repositories you add to Orca appear here." />
          ) : (
            current.projects.map((project) => <ProjectCard key={project.key} project={project} current={current} />)
          )}
          <AccountsSection current={current} />
          <Text muted size="xs">
            Orca data folder: {current.orcaDataDir ?? 'Unknown (set it in the settings)'}
          </Text>
        </Stack>
      )}
    </Stack>
  )
}
