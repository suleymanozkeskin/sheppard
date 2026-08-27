import type { ApiResult, AckResult, MsgrApi } from "./types"
import { withMockFallback } from "./runtime"

export function highestContiguousVisibleId(
  messages: Array<{ id: number }>,
  visibleMessageIds: readonly string[],
): number | undefined {
  const visible = new Set(visibleMessageIds)
  let highest: number | undefined
  let runStarted = false

  for (const message of messages) {
    if (visible.has(String(message.id))) {
      highest = message.id
      runStarted = true
      continue
    }
    if (runStarted) break
  }

  return highest
}

type Acknowledge = (channel: string, throughId: number) => ApiResult<AckResult>

export class AckScheduler {
  private readonly pending = new Map<string, number>()
  private readonly lastFlushed = new Map<string, number>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Set<string>()
  private closed = false
  private readonly acknowledge: Acknowledge
  private readonly onAcknowledged: ((channel: string, throughId: number) => void) | undefined
  private readonly delayMs: number

  public constructor(acknowledge: Acknowledge, delayMs = 200, onAcknowledged?: (channel: string, throughId: number) => void) {
    this.acknowledge = acknowledge
    this.delayMs = delayMs
    this.onAcknowledged = onAcknowledged
  }

  public enqueue(channel: string, throughId: number): void {
    if (this.closed || !Number.isInteger(throughId)) return
    if (throughId <= (this.lastFlushed.get(channel) ?? 0)) return
    const previous = this.pending.get(channel) ?? 0
    this.pending.set(channel, Math.max(previous, throughId))
    this.schedule(channel)
  }

  public close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pending.clear()
  }

  private schedule(channel: string): void {
    if (this.inFlight.has(channel) || this.timers.has(channel)) return
    const timer = setTimeout(() => {
      this.timers.delete(channel)
      this.flush(channel)
    }, this.delayMs)
    this.timers.set(channel, timer)
  }

  private flush(channel: string): void {
    if (this.closed || this.inFlight.has(channel)) return
    const throughId = this.pending.get(channel)
    if (throughId === undefined) return
    this.pending.delete(channel)
    this.inFlight.add(channel)

    void this.acknowledge(channel, throughId)
      .then((result) => {
        result.match({
          ok: () => {
            const previous = this.lastFlushed.get(channel) ?? 0
            this.lastFlushed.set(channel, Math.max(previous, throughId))
            const pending = this.pending.get(channel)
            if (pending !== undefined && pending <= throughId) this.pending.delete(channel)
            this.onAcknowledged?.(channel, throughId)
          },
          err: () => undefined,
        })
      })
      .finally(() => {
        this.inFlight.delete(channel)
        if (!this.closed && this.pending.has(channel)) this.schedule(channel)
      })
  }
}

export function createAckScheduler(
  api: MsgrApi,
  fallback: MsgrApi | undefined,
  onAcknowledged?: (channel: string, throughId: number) => void,
): AckScheduler {
  return new AckScheduler(
    (channel, throughId) => withMockFallback(
      () => api.acknowledge(channel, { throughId }),
      fallback === undefined ? undefined : () => fallback.acknowledge(channel, { throughId }),
    ),
    200,
    onAcknowledged,
  )
}
