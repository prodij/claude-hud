import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'hud',
  component: 'Pane',
  requestId: 'hud',
  props: {
    title: 'HUD',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'hud',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('the guard refuses destructive commands and passes the rest', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 0 }))

  for (const command of [
    'psql -c "DROP TABLE orders"',
    'aws s3 ls --profile acme-PROD-admin',
    'AWS_PROFILE=prod-admin aws s3 ls',
    'git push --force origin claude/x',
    'rm -rf ~',
  ]) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toMatch(/hud guard: refused \(/)
  }

  for (const command of ['ls', 'git push -u origin claude/x', 'rm -rf dist']) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toBeUndefined()
  }
})

test('the pane switches tabs and lists a block, on every surface', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 0 }))
  await $.tool.call({ tool: 'Bash', command: 'mysql -e "truncate table users"' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No reading yet/ })).toBeDefined()

    await ui.press({ key: 'tab-guard' })
    expect((await ui.find({ type: 'Text', text: /Blocked/ }))?.text).toBe('Blocked 1 this session')

    await ui.press({ key: 'tab-context' })
    await ui.unmount()
  }
})

test('the band stays hidden below the threshold and shows above it', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  let percent = 40
  on('state.get', (_, e, next) =>
    e.key === 'usage'
      ? { value: { value: { tokens: percent * 2000, window: 200000, percent }, version: 1 } }
      : next(e),
  )

  const quiet = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await quiet.find({ type: 'Text' }))?.text).toBe('engine')
  await quiet.unmount()

  percent = 88
  const loud = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await loud.find({ type: 'Text', text: /Context 88%/ }))?.text).toMatch(/176k \/ 200k/)
  await loud.unmount()
})

test('the context tab shows the reading and the plan limits', async ($, on) => {
  on('state.get', (_, e, next) =>
    e.key === 'usage'
      ? {
          value: {
            value: { tokens: 84000, window: 200000, percent: 42, fiveHour: 30, usd: 1.5 },
            version: 1,
          },
        }
      : next(e),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.text).toBe('42%')
    expect(await ui.find({ type: 'Text', text: /84k of 200k · 116k free/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
    await ui.unmount()
  }
})
