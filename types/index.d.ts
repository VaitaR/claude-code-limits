export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  costUsd: number | null
  /** `resetsAt` in ms; null when the window reported none. `at`: when the reading arrived, in ms. */
  limits: { kind: string; pct: number; resetsAt?: number | null; at?: number }[]
  compactions: number
  /**
   * The window Claude Code compacts against (`autoCompactWindow` in settings, or the model's own limit),
   * read from the session's context breakdown; null until read. Context is measured against it.
   */
  compactWindow: number | null
}

/**
 * A subagent running now, by the id its spawn returned. The rest is optional: a value saved before they
 * existed still reads, and each is set only once its event was seen.
 */
export type Running = {
  id: string
  type: string
  /** The Agent call's few-word `description`. */
  description?: string
  /** The model its last request was answered by, else the one its spawn resolved. */
  model?: string
  startedAt?: number
  /** Its last request's context: sent plus answered tokens. */
  tokens?: number
  /** Tool calls its loop has started. */
  tools?: number
  /** Its latest tool call, as `activityOf` names it. */
  activity?: string
}

/** A session's cost split by transcript, as the `costCommand` priced it when `at`. */
export type CostSplit = {
  at: number
  totalUsd: number
  mainUsd: number
  /** Calls no price covered: while above 0 the figures are a lower bound. */
  unpriced: number
  agents: { type: string; description: string; usd: number }[]
}

/** The person's last prompt as one line; `at` is when it was sent, null when read back from the transcript. */
export type LastPrompt = { text: string; at: number | null }

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
      /** The person's prompts since load or /clear, oldest first, the last PROMPTS_KEPT. */
      prompts: LastPrompt[]
    }
  }
}
