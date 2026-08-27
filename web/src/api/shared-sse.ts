import { Result } from "better-result"
import * as v from "valibot"

import { messageSchema, receiptUpdateSchema, workspaceListSchema } from "./schemas"
import { MessageSseClient, SseError, type SseClientOptions, type SseHandlers } from "./sse"
import type { Message, ReceiptUpdate, WorkspaceList } from "./types"

const DEFAULT_CHANNEL_NAME = "sheppard-events"
const DEFAULT_LOCK_NAME = "sheppard-events-leader"
const DEFAULT_ELECTION_DELAY_MS = 250
const integer = v.pipe(v.number(), v.integer())
const streamStateSchema = v.picklist(["connecting", "live", "reconnecting", "degraded", "offline"])

const sharedEventSchema = v.variant("type", [
  v.object({ type: v.literal("hello"), sender: v.string() }),
  v.object({
    type: v.literal("leader"),
    epoch: v.string(),
    lastEventId: v.optional(v.string()),
    sequence: integer,
    streamState: streamStateSchema,
  }),
  v.object({
    type: v.literal("state"),
    epoch: v.string(),
    lastEventId: v.optional(v.string()),
    sequence: integer,
    streamState: streamStateSchema,
  }),
  v.object({
    type: v.literal("open"),
    epoch: v.string(),
    lastEventId: v.optional(v.string()),
    reconnecting: v.boolean(),
    sequence: integer,
  }),
  v.object({
    type: v.literal("message"),
    epoch: v.string(),
    eventId: v.optional(v.string()),
    lastEventId: v.optional(v.string()),
    message: messageSchema,
    sequence: integer,
  }),
  v.object({
    type: v.literal("receipt"),
    epoch: v.string(),
    eventId: v.optional(v.string()),
    lastEventId: v.optional(v.string()),
    receipt: receiptUpdateSchema,
    sequence: integer,
  }),
  v.object({
    type: v.literal("topology"),
    epoch: v.string(),
    eventId: v.optional(v.string()),
    lastEventId: v.optional(v.string()),
    sequence: integer,
    snapshot: workspaceListSchema,
  }),
  v.object({
    type: v.literal("error"),
    epoch: v.string(),
    lastEventId: v.optional(v.string()),
    message: v.string(),
    sequence: integer,
    status: v.optional(integer),
  }),
  v.object({
    type: v.literal("degraded"),
    degraded: v.boolean(),
    epoch: v.string(),
    lastEventId: v.optional(v.string()),
    sequence: integer,
  }),
])

type SharedEvent = v.InferOutput<typeof sharedEventSchema>
type SharedDataEvent = Exclude<SharedEvent, { type: "hello" | "leader" | "state" }>
type SharedEventPayload =
  | { type: "open"; reconnecting: boolean }
  | { type: "message"; eventId?: string; message: Message }
  | { type: "receipt"; eventId?: string; receipt: ReceiptUpdate }
  | { type: "topology"; eventId?: string; snapshot: WorkspaceList }
  | { type: "error"; message: string; status?: number }
  | { type: "degraded"; degraded: boolean }
export type SharedStreamState = v.InferOutput<typeof streamStateSchema>

export interface SharedSseOptions extends SseClientOptions {
  channelName?: string
  electionDelayMs?: number
  lockName?: string
}

export interface SharedSseHandlers extends SseHandlers {
  onState?: (state: SharedStreamState) => void
  onUnavailable?: () => void
}

/** Shares one reconnecting message stream between same-origin browser tabs. */
export class SharedMessageSseClient {
  private readonly options: SharedSseOptions
  private readonly handlers: SharedSseHandlers
  private readonly channelName: string
  private readonly lockName: string
  private readonly electionDelayMs: number
  private readonly tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  private channel: BroadcastChannel | undefined
  private leaderStream: MessageSseClient | undefined
  private leaderStop: (() => void) | undefined
  private electionTimer: ReturnType<typeof setTimeout> | undefined
  private electionInFlight = false
  private running = false
  private leader = false
  private hadLeadership = false
  private currentEpoch: string | undefined
  private lastEventId: string | undefined
  private lastSequence = 0
  private streamState: SharedStreamState = "connecting"

  public constructor(options: SharedSseOptions, handlers: SharedSseHandlers) {
    this.options = options
    this.handlers = handlers
    this.channelName = options.channelName ?? DEFAULT_CHANNEL_NAME
    this.lockName = options.lockName ?? DEFAULT_LOCK_NAME
    this.electionDelayMs = Math.max(options.electionDelayMs ?? DEFAULT_ELECTION_DELAY_MS, 0)
  }

  public start(): Result<void, SseError> {
    if (this.running) {
      return Result.err(new SseError({ cause: undefined, message: "The shared event stream is already running" }))
    }
    this.running = true
    if (globalThis.navigator?.locks === undefined || globalThis.BroadcastChannel === undefined) {
      this.running = false
      this.setState("offline")
      this.handlers.onUnavailable?.()
      return Result.ok(undefined)
    }
    try {
      this.channel = new BroadcastChannel(this.channelName)
      this.channel.onmessage = (event) => {
        const parsed = v.safeParse(sharedEventSchema, event.data)
        if (parsed.success) this.receive(parsed.output)
      }
      this.channel.postMessage({ sender: this.tabId, type: "hello" })
      void this.tryAcquire()
      return Result.ok(undefined)
    } catch (cause) {
      this.running = false
      this.setState("offline")
      this.handlers.onUnavailable?.()
      return Result.err(new SseError({ cause, message: "The shared event stream could not start" }))
    }
  }

  public close(): void {
    this.running = false
    if (this.electionTimer !== undefined) clearTimeout(this.electionTimer)
    this.electionTimer = undefined
    this.leaderStop?.()
    this.leaderStop = undefined
    this.leaderStream?.close()
    this.leaderStream = undefined
    this.channel?.close()
    this.channel = undefined
  }

  private async tryAcquire(): Promise<void> {
    if (!this.running || this.electionInFlight) return
    this.electionInFlight = true
    try {
      await globalThis.navigator.locks.request(this.lockName, { ifAvailable: true }, async (lock) => {
        if (lock === null || !this.running) return
        await this.runAsLeader()
      })
    } catch {
      if (this.running) {
        this.running = false
        this.setState("offline")
        this.handlers.onUnavailable?.()
      }
      return
    } finally {
      this.electionInFlight = false
    }
    if (this.running && !this.leader) this.scheduleElection()
  }

  private scheduleElection(): void {
    if (!this.running || this.electionTimer !== undefined) return
    this.electionTimer = setTimeout(() => {
      this.electionTimer = undefined
      void this.tryAcquire()
    }, this.electionDelayMs)
  }

  private async runAsLeader(): Promise<void> {
    this.leader = true
    this.hadLeadership = true
    this.currentEpoch = `${Date.now().toString(36)}-${this.tabId}`
    this.setState("connecting")
    this.channel?.postMessage({
      epoch: this.currentEpoch,
      lastEventId: this.lastEventId,
      sequence: this.lastSequence,
      streamState: this.streamState,
      type: "leader",
    })

    let resolveStop: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    this.leaderStop = resolveStop
    const streamOptions: SseClientOptions = { ...this.options, lastEventId: this.lastEventId }
    const stream = new MessageSseClient(
      streamOptions,
      {
        onDegraded: (degraded) => this.publishDegraded(degraded),
        onError: (error) => this.publishError(error),
        onMessage: (message, eventId) => this.publishMessage(message, eventId),
        onReceipt: (receipt, eventId) => this.publishReceipt(receipt, eventId),
        onOpen: (reconnecting) => this.publishOpen(reconnecting || (this.hadLeadership && this.lastSequence > 0)),
        onTopologySnapshot: (snapshot, eventId) => this.publishTopology(snapshot, eventId),
      },
    )
    this.leaderStream = stream
    stream.start().match({
      ok: () => undefined,
      err: (error) => this.publishError(error),
    })
    try {
      await stopped
    } finally {
      stream.close()
      this.leaderStream = undefined
      this.leaderStop = undefined
      this.leader = false
    }
  }

  private publishOpen(reconnecting: boolean): void {
    this.setState("live")
    this.publish({ reconnecting, type: "open" })
  }

  private publishMessage(message: Message, eventId: string | undefined): void {
    this.lastEventId = eventId ?? this.lastEventId
    this.publish({ eventId, message, type: "message" })
  }

  private publishReceipt(receipt: ReceiptUpdate, eventId: string | undefined): void {
    this.lastEventId = eventId ?? this.lastEventId
    this.publish({ eventId, receipt, type: "receipt" })
  }

  private publishTopology(snapshot: WorkspaceList, eventId: string | undefined): void {
    this.lastEventId = eventId ?? this.lastEventId
    this.publish({ eventId, snapshot, type: "topology" })
  }

  private publishError(error: SseError): void {
    this.setState("reconnecting")
    this.publish({ message: error.message, status: error.status, type: "error" })
  }

  private publishDegraded(degraded: boolean): void {
    this.setState(degraded ? "degraded" : "reconnecting")
    this.publish({ degraded, type: "degraded" })
  }

  private publish(event: SharedEventPayload): void {
    if (this.currentEpoch === undefined) return
    const next = {
      ...event,
      epoch: this.currentEpoch,
      lastEventId: this.lastEventId,
      sequence: this.lastSequence + 1,
    } satisfies SharedDataEvent
    this.lastSequence = next.sequence
    this.channel?.postMessage(next)
    this.deliver(next)
  }

  private receive(event: SharedEvent): void {
    switch (event.type) {
      case "hello":
        if (this.leader && this.currentEpoch !== undefined) {
          this.channel?.postMessage({
            epoch: this.currentEpoch,
            lastEventId: this.lastEventId,
            sequence: this.lastSequence,
            streamState: this.streamState,
            type: "state",
          })
        }
        return
      case "leader":
        if (this.acceptEpoch(event.epoch, event.sequence, event.lastEventId)) this.setState(event.streamState)
        return
      case "state":
        if (this.acceptEpoch(event.epoch, event.sequence, event.lastEventId)) this.setState(event.streamState)
        return
      case "open":
      case "message":
      case "receipt":
      case "topology":
      case "error":
      case "degraded":
        this.receiveData(event)
        return
    }
  }

  private receiveData(event: SharedDataEvent): void {
    if (this.currentEpoch !== undefined && this.currentEpoch !== event.epoch) {
      if (!this.isNewerEpoch(event.epoch, this.currentEpoch) || this.leader) return
      this.currentEpoch = event.epoch
      this.lastSequence = 0
    } else if (this.currentEpoch === undefined) {
      this.currentEpoch = event.epoch
    }
    if (event.sequence <= this.lastSequence) return
    this.lastSequence = event.sequence
    this.lastEventId = event.lastEventId ?? this.lastEventId
    this.deliver(event)
  }

  private acceptEpoch(epoch: string, sequence: number, lastEventId: string | undefined): boolean {
    if (this.currentEpoch === epoch) {
      if (sequence < this.lastSequence) return false
      this.lastSequence = sequence
      this.lastEventId = lastEventId ?? this.lastEventId
      return true
    }
    if (this.currentEpoch !== undefined && (this.leader || !this.isNewerEpoch(epoch, this.currentEpoch))) return false
    this.currentEpoch = epoch
    this.lastSequence = sequence
    this.lastEventId = lastEventId ?? this.lastEventId
    return true
  }

  private isNewerEpoch(next: string, current: string): boolean {
    const nextStamp = Number.parseInt(next.split("-", 1)[0] ?? "", 36)
    const currentStamp = Number.parseInt(current.split("-", 1)[0] ?? "", 36)
    if (Number.isNaN(nextStamp) || Number.isNaN(currentStamp)) return next > current
    return nextStamp > currentStamp || (nextStamp === currentStamp && next > current)
  }

  private deliver(event: SharedDataEvent): void {
    switch (event.type) {
      case "open":
        this.handlers.onOpen(event.reconnecting)
        return
      case "message":
        this.handlers.onMessage(event.message, event.eventId)
        return
      case "receipt":
        this.handlers.onReceipt?.(event.receipt, event.eventId)
        return
      case "topology":
        this.handlers.onTopologySnapshot?.(event.snapshot, event.eventId)
        return
      case "error":
        this.handlers.onError(new SseError({ cause: undefined, message: event.message, status: event.status }))
        return
      case "degraded":
        this.handlers.onDegraded?.(event.degraded)
        return
    }
  }

  private setState(state: SharedStreamState): void {
    this.streamState = state
    this.handlers.onState?.(state)
  }
}
