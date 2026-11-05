// "Claude 계정" panel: pick an account per project. The worker owns the data; this only asks.
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
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { AccountView, PanelState, ProjectView } from './protocol'

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

export function setup(_ctx: PanelContext): void {
  void refresh()
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

function ProjectCard({ project, accounts }: { project: ProjectView; accounts: AccountView[] }) {
  return (
    <Card
      title={project.name}
      description={project.stale ? 'Orca에 없는 프로젝트 (지정만 남아 있음)' : `워크스페이스 ${project.workspaces}개`}
    >
      <Stack gap="xs">
        <Select
          label={`${project.name} 계정`}
          labelHidden
          value={project.accountId ?? ORCA_DEFAULT}
          options={accountOptions(accounts, project.accountId)}
          disabled={read(busy)}
          onChange={(value) => void setRoute(project.key, value)}
        />
        <Text muted size="xs" truncate>
          {project.key}
        </Text>
      </Stack>
    </Card>
  )
}

function AccountsSection({ accounts }: { accounts: AccountView[] }) {
  return (
    <Collapsible title="계정 목록" description={`${accounts.length}개`}>
      <Stack gap="sm">
        {accounts.length === 0 ? (
          <Text muted size="sm">
            Orca 설정 → Accounts에서 Claude 계정을 추가하면 여기에 나타납니다.
          </Text>
        ) : null}
        {accounts.map((account) => (
          <Row key={account.id} justify="between" gap="xs">
            <Stack gap="none">
              <Row gap="xs">
                <Text size="sm" weight="medium" truncate>
                  {account.label}
                </Text>
                <Badge tone={account.signedIn ? 'success' : 'warning'}>
                  {account.signedIn ? '로그인됨' : account.exists ? '로그인 필요' : '폴더 없음'}
                </Badge>
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
        ))}
        <Text weight="medium" size="sm">
          계정 폴더 직접 추가
        </Text>
        <Input label="이름" placeholder="예: 회사 계정" value={read(customLabel)} onChange={(v) => set(customLabel, v)} />
        <Input
          label="CLAUDE_CONFIG_DIR 폴더"
          placeholder={'C:\\Users\\me\\.claude-work'}
          value={read(customHome)}
          onChange={(v) => set(customHome, v)}
          onSubmit={() => void addCustom()}
        />
        <Button icon="add" variant="outline" disabled={!read(customHome).trim() || read(busy)} onPress={() => void addCustom()}>
          추가
        </Button>
        <Text muted size="xs">
          직접 추가한 폴더는 한 번 로그인해야 합니다:
        </Text>
        <Code block>{'$env:CLAUDE_CONFIG_DIR="<폴더>"; claude   # 그다음 /login'}</Code>
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const current = read(state)
  const error = read(failure)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>프로젝트별 Claude 계정</Heading>
        <IconButton icon="refresh" label="새로고침" variant="ghost" disabled={read(busy)} onPress={() => void refresh()} />
      </Row>
      {error ? (
        <Callout tone="danger" title="불러오지 못했습니다">
          {error}
        </Callout>
      ) : null}
      {!current ? (
        <Spinner label="불러오는 중" />
      ) : (
        <Stack gap="md">
          <Text muted size="sm">
            새로 여는 {current.agents.join(', ')} 터미널에 적용됩니다. 이미 실행 중이거나 복원된 세션은
            그대로입니다.
          </Text>
          {current.projects.length === 0 ? (
            <EmptyState icon="folder" title="프로젝트가 없습니다" description="Orca에 레포를 추가하면 여기에 나타납니다." />
          ) : (
            current.projects.map((project) => (
              <ProjectCard key={project.key} project={project} accounts={current.accounts} />
            ))
          )}
          <AccountsSection accounts={current.accounts} />
          <Text muted size="xs">
            Orca 데이터 폴더: {current.orcaDataDir ?? '알 수 없음 (설정에서 지정)'}
          </Text>
        </Stack>
      )}
    </Stack>
  )
}
