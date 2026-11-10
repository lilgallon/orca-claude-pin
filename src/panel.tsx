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
  env,
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
import { langFrom, messages, type Messages } from './core/i18n.ts'
import type { AccountUsageView, AccountView, PanelState, ProjectView } from './protocol'

const state = atom<PanelState | null>(null)
const failure = atom<string | null>(null)
const busy = atom(false)
const customLabel = atom('customLabel', '')
const customHome = atom('customHome', '')

const ORCA_DEFAULT = '__orca_default__'

/** The worker's language once it answers, so the panel and the worker's texts always agree. */
function tr(): Messages {
  return messages(read(state)?.lang ?? langFrom(env.locale) ?? 'en')
}

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

const refresh = () => run(() => plugin.request('state.get', { locale: env.locale }, { timeoutMs: 15000 }))
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

function accountOptions(t: Messages, accounts: AccountView[], current: string | null) {
  const options = [
    { value: ORCA_DEFAULT, label: t.orcaDefault },
    ...accounts.map((account) => ({
      value: account.id,
      label: `${account.label}${account.source === 'custom' ? t.addedByHand : ''}${
        !account.exists ? t.folderMissingSuffix : !account.signedIn ? t.signInNeededSuffix : ''
      }`
    }))
  ]
  if (current && !accounts.some((account) => account.id === current)) {
    options.push({ value: current, label: t.unknownAccount(current) })
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
  const t = tr()
  if (!usage) {
    return (
      <Text muted size="xs">
        {t.checkingUsage}
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
                {t.resets} <RelativeTime at={window.resetsAt} />
              </Text>
            ) : null}
          </Row>
          <Progress label={t.usageOf(window.label)} labelHidden value={window.percent} />
        </Stack>
      ))}
      <Text muted size="xs">
        {t.checked} <RelativeTime at={usage.checkedAt} />
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
  const t = tr()
  const { problem } = project
  const account = current.accounts.find((candidate) => candidate.id === project.accountId)
  return (
    <Card title={project.name} description={project.stale ? t.staleProject : t.workspaces(project.workspaces)}>
      <Stack gap="xs">
        <Select
          label={t.accountOf(project.name)}
          labelHidden
          value={project.accountId ?? ORCA_DEFAULT}
          options={accountOptions(t, current.accounts, project.accountId)}
          disabled={read(busy)}
          onChange={(value) => void setRoute(project.key, value)}
        />
        {problem ? (
          <Text tone="danger" size="sm">
            {problem} {current.onPinFailure === 'deny' ? t.untilFixedDeny : t.untilFixedPass}
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
          <Collapsible title={t.runDirectlyTitle}>
            <Stack gap="xs">
              <Text muted size="xs">
                {t.runDirectlyHint}
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
  const t = tr()
  const { accounts, platform, usage } = current
  const examplePath = platform === 'win32' ? 'C:\\Users\\me\\.claude-work' : '/Users/me/.claude-work'
  const loginCommand =
    platform === 'win32'
      ? `$env:CLAUDE_CONFIG_DIR="<${t.loginFolder}>"; claude   # ${t.loginThen}`
      : `CLAUDE_CONFIG_DIR='<${t.loginFolder}>' claude   # ${t.loginThen}`
  return (
    <Collapsible title={t.accountsAndUsage} description={`${accounts.length}`} defaultOpen>
      <Stack gap="sm">
        {accounts.length === 0 ? (
          <Text muted size="sm">
            {t.accountsEmpty}
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
                  {account.home === current.selectedHome ? <Badge tone="accent">{t.badgeSelected}</Badge> : null}
                  {account.signedIn ? null : (
                    <Badge tone="warning">{account.exists ? t.badgeSignInNeeded : t.badgeFolderMissing}</Badge>
                  )}
                </Row>
                <Text muted size="xs" truncate>
                  {account.home}
                </Text>
              </Stack>
              {account.source === 'custom' ? (
                <IconButton
                  icon="delete"
                  label={t.removeFolder}
                  variant="ghost"
                  onPress={() => void run(() => plugin.request('custom.remove', { id: account.id }))}
                />
              ) : null}
            </Row>
            {usage && account.signedIn ? <UsageDetail usage={usage[account.id]} /> : null}
          </Stack>
        ))}
        <Switch
          label={t.showUsage}
          checked={usage !== null}
          disabled={read(busy)}
          onChange={(enabled) => void run(() => plugin.request('usage.setEnabled', { enabled }))}
        />
        <Text muted size="xs">
          {t.showUsageHint}
        </Text>
        <Text weight="medium" size="sm">
          {t.addByHandTitle}
        </Text>
        <Text muted size="xs">
          {t.addByHandHint}
        </Text>
        <Code block>{loginCommand}</Code>
        <Input
          label={t.nameLabel}
          placeholder={t.namePlaceholder}
          value={read(customLabel)}
          onChange={(v) => set(customLabel, v)}
        />
        <Input
          label={t.folderLabel}
          placeholder={examplePath}
          value={read(customHome)}
          onChange={(v) => set(customHome, v)}
          onSubmit={() => void addCustom()}
        />
        <Button icon="add" variant="outline" disabled={!read(customHome).trim() || read(busy)} onPress={() => void addCustom()}>
          {t.add}
        </Button>
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const t = tr()
  const current = read(state)
  const error = read(failure)
  const selected = current?.accounts.find((account) => account.home === current.selectedHome)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Claude Pin</Heading>
        <IconButton icon="refresh" label={t.refresh} variant="ghost" disabled={read(busy)} onPress={() => void refreshWithUsage()} />
      </Row>
      {error ? (
        <Callout tone="danger" title={t.requestFailed}>
          {error}
        </Callout>
      ) : null}
      {!current ? (
        <Spinner label={t.loading} />
      ) : (
        <Stack gap="md">
          <Text muted size="sm">
            {t.intro(selected?.label ?? current.selectedHome ?? 'System default')}
          </Text>
          {current.projects.length === 0 ? (
            <EmptyState icon="folder" title={t.noProjectsTitle} description={t.noProjectsDescription} />
          ) : (
            current.projects.map((project) => <ProjectCard key={project.key} project={project} current={current} />)
          )}
          <AccountsSection current={current} />
          <Text muted size="xs">
            {t.dataFolder(current.orcaDataDir)}
          </Text>
        </Stack>
      )}
    </Stack>
  )
}
