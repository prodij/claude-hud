import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Block, Breakdown, Run, Tab, Usage, Where } from '../types'

const PANE = 'hud'
const TABS: readonly Tab[] = ['context', 'where', 'agents', 'guard']
const LABELS: Record<Tab, string> = {
  context: 'Context',
  where: 'Where',
  agents: 'Agents',
  guard: 'Guard',
}

const tab = atom({ plugin: 'hud', key: 'tab' } as const, 'context' as Tab)
const usage = atom({ plugin: 'hud', key: 'usage' } as const, null as Usage | null)
const breakdown = atom(
  { plugin: 'hud', key: 'breakdown' } as const,
  null as Breakdown | null,
)
// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const where = atom({ plugin: 'hud', key: 'where' } as const, null as Where | null, {
  shape: 'where-2',
})
const runs = atom({ plugin: 'hud', key: 'runs' } as const, [] as Run[], {
  shape: 'runs-1',
})
const blocks = atom({ plugin: 'hud', key: 'blocks' } as const, [] as Block[], {
  shape: 'blocks-1',
})
// The highest context threshold already toasted; reset once usage drops.
const warned = atom({ plugin: 'hud', key: 'warned' } as const, 0)

const THRESHOLDS = [80, 90]
const BAND_AT = 85

// Commands the guard refuses. The model is told why; the person runs them by hand.
const RULES: readonly { rule: string; test: RegExp }[] = [
  {
    rule: 'destructive SQL',
    test: /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?\w)/i,
  },
  {
    rule: 'production AWS profile',
    test: /(--profile[= ]|AWS_PROFILE=)\S*prod/i,
  },
  {
    rule: 'force push',
    test: /\bgit\s+push\b[^|;&]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/,
  },
  { rule: 'rm -rf on / or ~', test: /\brm\s+-[a-z]*r[a-z]*\s+(\/|~)(\s|$)/i },
]

type Ui = ElementTable

const k = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`

const level = (percent: number) =>
  percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'success'

// A quarter-step dial for the one-line places: the status chip and the band.
const dial = (percent: number) => '○◔◑◕●'[Math.min(4, Math.floor(percent / 22))] ?? '○'

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 16)

const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

const awsTone = (profile: string | null) =>
  profile === null
    ? 'inactive'
    : /prod/i.test(profile)
      ? 'error'
      : /read-?only|(^|[-_])ro($|[-_])/i.test(profile)
        ? 'success'
        : 'text'

// A thin line meter: the filled run in `color`, the rest as a dim track.
function meter(ui: Ui, fraction: number, width: number, color: string) {
  const { Text } = ui
  const full = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return (
    <Text mono>
      <Text color={color}>{'━'.repeat(full)}</Text>
      <Text dimColor>{'─'.repeat(width - full)}</Text>
    </Text>
  )
}

function heading(ui: Ui, text: string) {
  const { Text } = ui
  return (
    <Text size="caption" weight="semibold" dimColor>
      {text.toUpperCase()}
    </Text>
  )
}

// Every section of the pane sits in one of these.
const CARD = {
  flexDirection: 'column',
  borderStyle: 'round',
  borderDimColor: true,
  paddingX: 1,
  gap: 'xs',
} as const

const chip = (u: Usage | null, w: Where | null) => {
  const parts: string[] = []
  if (u?.percent !== undefined) parts.push(`${dial(u.percent)} ${u.percent}%`)
  if (w) parts.push(`${w.branch}${w.ahead > 0 ? ` ↑${w.ahead}` : ''}${w.changed > 0 ? ` ±${w.changed}` : ''}`)
  parts.push('/hud')
  return parts.join('  ·  ')
}

// The chip is this plugin's status line under the prompt: the desktop draws
// that, where it does not draw a rewritten prompt hint.
async function pushChip($: EngineInterface) {
  $.ui.status(chip(await read($, usage), await read($, where)))
}

async function refreshWhere($: EngineInterface) {
  const cwd = await $.session.cwd()
  const repo = await $.session.repo()
  const aws = (await $.env.get('AWS_PROFILE')) ?? null
  let branch = '–'
  let ahead = 0
  let behind = 0
  let changed = 0
  try {
    const { exitCode, stdout } = await $.process.run(
      ['git', 'status', '--porcelain=v1', '--branch'],
      { timeoutMs: 5000 },
    )
    if (exitCode === 0) {
      const [head = '', ...rest] = stdout.split('\n').filter(Boolean)
      branch = head.replace(/^## /, '').split('...')[0] ?? '–'
      ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
      behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
      changed = rest.length
    }
  } catch {
    // Not a repository, or git missing: the tab shows what it has.
  }
  const name = (repo?.root ?? cwd).split('/').filter(Boolean).pop() ?? cwd
  await update($, where, () => ({ repo: name, branch, ahead, behind, changed, aws }))
  await pushChip($)
}

async function refreshBreakdown($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const b = context.breakdown
  if (!b) return
  const rows = b.categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens }))
    .sort((a, z) => z.tokens - a.tokens)
  const byServer = new Map<string, number>()
  for (const tool of b.mcpTools) {
    byServer.set(tool.serverName, (byServer.get(tool.serverName) ?? 0) + tool.tokens)
  }
  const servers = [...byServer]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, z) => z.tokens - a.tokens)
    .slice(0, 4)
  const at = await $.clock.now()
  await update($, breakdown, () => ({
    total: b.totalTokens,
    max: b.rawMaxTokens,
    rows,
    servers,
    at,
  }))
}

async function contextBody($: EngineInterface, ui: Ui, width: number) {
  const { Box, Text, Button } = ui
  const u = await read($, usage)
  const b = await read($, breakdown)
  const label = 14
  const bar = Math.max(8, Math.min(32, width - label - 7))

  const hero =
    u?.percent !== undefined ? (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" gap={1} alignItems="flex-end">
          <Text size="title" weight="semibold" tabular color={level(u.percent)}>
            {u.percent}%
          </Text>
          <Text dimColor tabular>
            {k(u.tokens ?? 0)} of {k(u.window)} · {k(u.window - (u.tokens ?? 0))} free
          </Text>
        </Box>
        {meter(ui, u.percent / 100, bar + label + 6, level(u.percent))}
      </Box>
    ) : (
      <Text dimColor>No reading yet: it arrives with the next response.</Text>
    )

  const limit = (name: string, percent: number | undefined) => (
    <Text mono tabular>
      <Text dimColor>{name.padEnd(label)}</Text>
      {percent === undefined ? (
        <Text dimColor>–</Text>
      ) : (
        <Text>
          {meter(ui, percent / 100, bar, level(percent))}
          {` ${String(Math.round(percent)).padStart(3)}%`}
        </Text>
      )}
    </Text>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box {...CARD}>
        {heading(ui, 'Context window')}
        {hero}
      </Box>

      <Box {...CARD}>
        {heading(ui, "What's using it")}
        {b ? (
          <Box flexDirection="column">
            {b.rows.slice(0, 7).map(r => (
              <Text mono tabular>
                {cut(r.name, label - 1).padEnd(label)}
                {meter(ui, r.tokens / b.max, bar, 'claude')}
                {` ${k(r.tokens).padStart(5)}`}
              </Text>
            ))}
            {b.servers.length > 0 && (
              <Text dimColor>
                MCP  {b.servers.map(s => `${s.name} ${k(s.tokens)}`).join('  ·  ')}
              </Text>
            )}
          </Box>
        ) : (
          <Text dimColor>Press Refresh to break the window down.</Text>
        )}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refreshBreakdown($)} />
          {b && <Text size="caption" dimColor>estimate · {clock(b.at)} UTC</Text>}
        </Box>
      </Box>

      <Box {...CARD}>
        {heading(ui, 'Plan limits')}
        {limit('5-hour', u?.fiveHour)}
        {limit('Week', u?.week)}
        <Text mono tabular>
          <Text dimColor>{'Cost'.padEnd(label)}</Text>
          {u?.usd !== undefined ? `$${u.usd.toFixed(2)}` : <Text dimColor>–</Text>}
        </Text>
      </Box>
    </Box>
  )
}

async function whereBody($: EngineInterface, ui: Ui) {
  const { Box, Text } = ui
  const w = await read($, where)
  if (!w) return <Text dimColor>Reading the repository…</Text>
  const row = (name: string, value: RenderChildren) => (
    <Text mono>
      <Text dimColor>{name.padEnd(9)}</Text>
      {value}
    </Text>
  )
  return (
    <Box {...CARD}>
      {heading(ui, 'Repository')}
      <Text size="heading" weight="semibold">
        {w.repo}
      </Text>
      <Box flexDirection="column">
        {row('branch', w.branch)}
        {row(
          'sync',
          w.ahead === 0 && w.behind === 0 ? (
            <Text dimColor>even with upstream</Text>
          ) : (
            <Text color="suggestion">
              {[w.ahead > 0 && `↑${w.ahead} ahead`, w.behind > 0 && `↓${w.behind} behind`]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          ),
        )}
        {row(
          'changes',
          w.changed === 0 ? (
            <Text color="success">clean</Text>
          ) : (
            <Text color="warning">{w.changed} changed</Text>
          ),
        )}
        {row('aws', <Text color={awsTone(w.aws)}>● {w.aws ?? 'unset'}</Text>)}
      </Box>
    </Box>
  )
}

async function agentsBody($: EngineInterface, ui: Ui, width: number) {
  const { Box, Text } = ui
  const list = (await read($, runs)).slice(-10).reverse()
  const now = await $.clock.now()
  if (list.length === 0) return <Text dimColor>No subagents this session yet.</Text>
  return (
    <Box {...CARD}>
      {heading(ui, 'Subagents')}
      <Box flexDirection="column">
        {list.map(r => {
          const state = r.endedAt === undefined ? 'running' : r.isFailed ? 'stopped' : 'done'
          const tone = state === 'running' ? 'suggestion' : state === 'stopped' ? 'error' : 'success'
          return (
            <Text mono tabular dimColor={state === 'done'}>
              <Text color={tone}>● </Text>
              {state.padEnd(8)}
              {ago((r.endedAt ?? now) - r.startedAt).padStart(6)}  {cut(r.label, Math.max(16, width - 22))}
            </Text>
          )
        })}
      </Box>
    </Box>
  )
}

async function guardBody($: EngineInterface, ui: Ui, width: number) {
  const { Box, Text } = ui
  const list = (await read($, blocks)).slice(-10).reverse()
  return (
    <Box flexDirection="column" gap={1}>
      <Box {...CARD}>
        {heading(ui, 'Blocked this session')}
        {list.length === 0 ? (
          <Text color="success">● Nothing blocked this session.</Text>
        ) : (
          <Box flexDirection="column">
            <Text color="error" weight="semibold">
              Blocked {list.length} this session
            </Text>
            {list.map(b => (
              <Text mono>
                <Text dimColor>{clock(b.at)}  </Text>
                <Text color="error">{b.rule}</Text>
                <Text dimColor>  {cut(b.command, Math.max(16, width - b.rule.length - 12))}</Text>
              </Text>
            ))}
          </Box>
        )}
      </Box>
      <Box {...CARD}>
        {heading(ui, 'Rules')}
        <Box flexDirection="column">
          {RULES.map(r => (
            <Text>
              <Text dimColor>· </Text>
              {r.rule}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'Open the HUD: context breakdown, where you are, agents, guard',
    })
    const started = await next(e)
    await refreshWhere($)
    return started
  })

  on('command.run', { command: 'hud' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'HUD' })
    if (!opened.isPlaced) return { text: `HUD not shown: ${opened.reason}` }
    await Promise.all([refreshBreakdown($), refreshWhere($)])
    return { text: 'HUD opened. Esc or the close mark hides it.' }
  })

  on('session.measure', async ($, e, next) => {
    const five = e.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed
    const week = e.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed
    await update($, usage, () => ({
      tokens: e.context.tokens,
      window: e.context.window,
      percent: e.context.percent,
      fiveHour: five,
      week,
      usd: e.cost?.usd,
    }))
    if (e.changed.includes('context')) await pushChip($)

    const p = e.context.percent
    if (p !== undefined && e.changed.includes('context')) {
      const last = await read($, warned)
      const hit = [...THRESHOLDS].reverse().find(t => p >= t)
      if (hit !== undefined && hit > last) {
        const left = e.context.window - (e.context.tokens ?? 0)
        $.ui.toast(`${dial(p)} Context at ${p}%, about ${k(left)} tokens left. /hud shows what's using it.`, {
          timeoutMs: 8000,
        })
        await update($, warned, () => hit)
      } else if (p < 70 && last > 0) {
        await update($, warned, () => 0)
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const hit = RULES.find(r => r.test.test(e.command))
    if (!hit) return next(e)
    const at = await $.clock.now()
    await update($, blocks, list => [...list, { at, rule: hit.rule, command: e.command.slice(0, 160) }].slice(-50))
    $.ui.toast(`HUD guard blocked ${hit.rule}: ${cut(e.command, 60)}`, { timeoutMs: 10000 })
    return {
      deny: `hud guard: refused (${hit.rule}). Do not retry or work around it; tell the user the exact command so they can run it themselves if they mean it.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'hud guard: its check failed.' }))

  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const open = (await read($, runs)).some(r => r.id === id && r.endedAt === undefined)
      if (!open) {
        const info = (await $.agent.list()).find(a => a.id === id)
        const label = info ? `${info.type} · ${info.description}` : id
        const startedAt = await $.clock.now()
        await update($, runs, list => [...list, { id, label, startedAt }].slice(-30))
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    if (id === undefined) {
      await refreshWhere($)
      return done
    }
    const endedAt = await $.clock.now()
    const isFailed = e.reason !== 'answer'
    let finished: Run | undefined
    await update($, runs, list =>
      list.map(r => {
        if (r.id !== id || r.endedAt !== undefined) return r
        finished = { ...r, endedAt, isFailed }
        return finished
      }),
    )
    if (finished) {
      $.ui.toast(
        `${isFailed ? '✕' : '✓'} ${cut(finished.label, 50)} ${isFailed ? 'stopped' : 'finished'} · ${ago(endedAt - finished.startedAt)}`,
      )
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u?.percent === undefined || u.percent < BAND_AT) return next(e)
    const ui = $.ui.resolve(e)
    const { Text } = ui
    const tone = level(u.percent)
    return (
      <Text tabular>
        <Text color={tone} weight="semibold">
          {dial(u.percent)} Context {u.percent}%{' '}
        </Text>
        {meter(ui, u.percent / 100, 16, tone)}
        <Text dimColor>
          {' '}
          {k(u.tokens ?? 0)} / {k(u.window)} · /hud shows what's using it
        </Text>
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button } = ui
    const current = await read($, tab)
    // The cards' border and padding take four columns.
    const width = Math.max(24, e.props.bodyColumns - 4)

    const running = (await read($, runs)).filter(r => r.endedAt === undefined).length
    const blocked = (await read($, blocks)).length
    const badge: Partial<Record<Tab, number>> = { agents: running, guard: blocked }

    const tabs = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {TABS.map((t, i) => (
          <Button
            key={`tab-${t}`}
            label={badge[t] ? `${LABELS[t]} · ${badge[t]}` : LABELS[t]}
            hotkey={String(i + 1)}
            variant={t === current ? 'primary' : 'secondary'}
            dimColor={t !== current ? true : undefined}
            onPress={() => update($, tab, () => t)}
          />
        ))}
      </Box>
    )

    const body =
      current === 'context'
        ? await contextBody($, ui, width)
        : current === 'where'
          ? await whereBody($, ui)
          : current === 'agents'
            ? await agentsBody($, ui, width)
            : await guardBody($, ui, width)

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {body}
      </Box>
    )
  })
}
