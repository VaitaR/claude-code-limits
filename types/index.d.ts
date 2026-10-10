export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  costUsd: number | null
  /** `resetsAt` in ms; null when the window reported none. */
  limits: { kind: string; pct: number; resetsAt?: number | null }[]
  compactions: number
  /**
   * The window Claude Code compacts against (`autoCompactWindow` in settings, or the model's own limit),
   * read from the session's context breakdown; null until read. Context is measured against it.
   */
  compactWindow: number | null
}

/** A subagent running now, by the id its spawn returned. */
export type Running = { id: string; type: string }

/** A session's cost split by transcript, as the `costCommand` priced it when `at`. */
export type CostSplit = {
  at: number
  totalUsd: number
  mainUsd: number
  /** Calls no price covered: while above 0 the figures are a lower bound. */
  unpriced: number
  agents: { type: string; description: string; usd: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'limits': {
      usage: Usage
      /**
       * When the main loop last sent a request that got a response: each request reads (or writes) the
       * prompt cache and restarts its TTL. The request's start, not its end, so a long response never
       * overstates the time left. 0: none since load, /clear or a compaction.
       */
      cacheAt: number
      running: Running[]
      /** The session's cost when the current main turn started; null when the host reports none. */
      costAtStart: number | null
      /** What the last main turn cost; null before one ends or without a cost. */
      lastTurnUsd: number | null
      split: CostSplit | null
    }
  }
}
