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
    { value: ORCA_DEFAULT, label: 'Orca 기본 (전역으로 선택된 계정)' },
    ...accounts.map((account) => ({
      value: account.id,
      label: `${account.label}${account.source === 'custom' ? ' · 직접 추가' : ''}${
        !account.exists ? ' (폴더 없음)' : !account.signedIn ? ' (로그인 필요)' : ''
      }`
    }))
  ]
  if (current && !accounts.some((account) => account.id === current)) {
    options.push({ value: current, label: `알 수 없는 계정 ${current}` })
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
        사용량 확인 중
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
                <RelativeTime at={window.resetsAt} /> 초기화
              </Text>
            ) : null}
          </Row>
          <Progress label={`${window.label} 사용량`} labelHidden value={window.percent} />
        </Stack>
      ))}
      <Text muted size="xs">
        <RelativeTime at={usage.checkedAt} /> 확인
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
      description={project.stale ? 'Orca 목록에 없는 프로젝트' : `워크스페이스 ${project.workspaces}개`}
    >
      <Stack gap="xs">
        <Select
          label={`${project.name} 계정`}
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
              ? '고치기 전까지 이 프로젝트의 새 Claude 실행은 거부됩니다.'
              : '고치기 전까지 이 프로젝트의 새 Claude는 Orca에서 선택한 계정으로 실행됩니다.'}
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
          <Collapsible title="터미널에서 직접 실행하려면">
            <Stack gap="xs">
              <Text muted size="xs">
                직접 입력한 claude에는 지정이 적용되지 않습니다. 이 명령을 쓰세요:
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
      ? '$env:CLAUDE_CONFIG_DIR="<폴더>"; claude   # 그다음 /login'
      : "CLAUDE_CONFIG_DIR='<폴더>' claude   # 그다음 /login"
  return (
    <Collapsible title="계정과 사용량" description={`${accounts.length}개`} defaultOpen>
      <Stack gap="sm">
        {accounts.length === 0 ? (
          <Text muted size="sm">
            Orca 설정 → Accounts에서 Claude 계정을 추가하면 여기에 나타납니다.
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
                  {account.home === current.selectedHome ? <Badge tone="accent">Orca 선택</Badge> : null}
                  {account.signedIn ? null : (
                    <Badge tone="warning">{account.exists ? '로그인 필요' : '폴더 없음'}</Badge>
                  )}
                </Row>
                <Text muted size="xs" truncate>
                  {account.home}
                </Text>
              </Stack>
              {account.source === 'custom' ? (
                <IconButton
                  icon="delete"
                  label="이 계정 폴더 제거"
                  variant="ghost"
                  onPress={() => void run(() => plugin.request('custom.remove', { id: account.id }))}
                />
              ) : null}
            </Row>
            {usage && account.signedIn ? <UsageDetail usage={usage[account.id]} /> : null}
          </Stack>
        ))}
        <Text weight="medium" size="sm">
          계정 폴더 직접 추가
        </Text>
        <Text muted size="xs">
          먼저 그 폴더로 로그인하세요. Orca의 상태 표시와 공유 설정은 Orca 계정에만 적용됩니다.
        </Text>
        <Code block>{loginCommand}</Code>
        <Input label="이름" placeholder="예: 회사 계정" value={read(customLabel)} onChange={(v) => set(customLabel, v)} />
        <Input
          label="CLAUDE_CONFIG_DIR 폴더"
          placeholder={examplePath}
          value={read(customHome)}
          onChange={(v) => set(customHome, v)}
          onSubmit={() => void addCustom()}
        />
        <Button icon="add" variant="outline" disabled={!read(customHome).trim() || read(busy)} onPress={() => void addCustom()}>
          추가
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
        <IconButton icon="refresh" label="새로고침" variant="ghost" disabled={read(busy)} onPress={() => void refreshWithUsage()} />
      </Row>
      {error ? (
        <Callout tone="danger" title="요청을 처리하지 못했습니다">
          {error}
        </Callout>
      ) : null}
      {!current ? (
        <Spinner label="불러오는 중" />
      ) : (
        <Stack gap="md">
          <Text muted size="sm">
            새로 여는 Claude 터미널에 적용됩니다. 복원·resume 세션, 네이티브 채팅, 직접 입력한 claude, Orca 시작 직후의
            실행은 Orca에서 선택한 계정({selected?.label ?? (current.selectedHome ?? 'System default')})을 씁니다.
          </Text>
          {current.projects.length === 0 ? (
            <EmptyState icon="folder" title="프로젝트가 없습니다" description="Orca에 레포를 추가하면 여기에 나타납니다." />
          ) : (
            current.projects.map((project) => <ProjectCard key={project.key} project={project} current={current} />)
          )}
          <AccountsSection current={current} />
          <Text muted size="xs">
            Orca 데이터 폴더: {current.orcaDataDir ?? '알 수 없음 (설정에서 지정)'}
          </Text>
        </Stack>
      )}
    </Stack>
  )
}
