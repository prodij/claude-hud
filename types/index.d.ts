export type Tab = 'context' | 'where' | 'agents' | 'guard'

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  fiveHour?: number
  week?: number
  usd?: number
}

export type Row = { name: string; tokens: number }

export type Breakdown = {
  total: number
  max: number
  rows: Row[]
  servers: Row[]
  at: number
}

export type Where = {
  repo: string
  branch: string
  hasUpstream: boolean
  ahead: number
  behind: number
  changed: number
  aws: string | null
}

export type Run = {
  id: string
  label: string
  startedAt: number
  endedAt?: number
  isFailed?: boolean
}

export type Block = { at: number; rule: string; command: string }

declare module 'claude-code' {
  interface PluginState {
    hud: {
      tab: Tab
      usage: Usage | null
      breakdown: Breakdown | null
      where: Shaped<Where | null>
      runs: Shaped<Run[]>
      blocks: Shaped<Block[]>
      warned: number
    }
  }
}
