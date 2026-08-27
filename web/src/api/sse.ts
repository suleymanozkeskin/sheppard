import { Result, TaggedError } from "better-result"
import * as v from "valibot"

import { messageSchema, receiptUpdateSchema, workspaceListSchema } from "./schemas"
import type { FetchImplementation, Message, WorkspaceList } from "./types"
import type { ReceiptUpdate } from "./types"

export interface SseMessageEvent {
  id: string | undefined
  event: string | undefined
  data: string
}

export class SseError extends TaggedError("SseError")<{
  message: string
  cause: unknown
  status?: number
}> {}

class SseParseError extends TaggedError("SseParseError")<{
  message: string
  cause: unknown
}> {}

export interface SseHandlers {
  onOpen: (reconnecting: boolean) => void
  onMessage: (message: Message, eventId?: string) => void
  onReceipt?: (update: ReceiptUpdate, eventId?: string) => void
  onError: (error: SseError) => void
  onDegraded?: (degraded: boolean) => void
  onTopologySnapshot?: (snapshot: WorkspaceList, eventId?: string) => void
}

export interface SseClientOptions {
  url: string
  token?: string
  fetchImpl?: FetchImplementation
  retryDelayMs?: number
  maxRetryDelayMs?: number
  retryJitterMs?: number
  degradedAfterFailures?: number
  degradedRetryDelayMs?: number
  random?: () => number
  lastEventId?: string
}

export interface TopologySseHandlers {
  onOpen: (reconnecting: boolean) => void
  onSnapshot: (snapshot: WorkspaceList) => void
  onError: (error: SseError) => void
}

function parseRecord(record: string): SseMessageEvent | undefined {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []
  for (const line of record.split("\n")) {
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "")
    if (field === "id") id = value
    if (field === "event") event = value
    if (field === "data") data.push(value)
  }
  return data.length === 0 ? undefined : { data: data.join("\n"), event, id }
}

export function parseSseRecords(
  input: string,
  flush = false,
): Result<{ events: SseMessageEvent[]; rest: string }, SseParseError> {
  const normalized = input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n")
  const parts = normalized.split("\n\n")
  const rest = flush ? "" : (parts.pop() ?? "")
  const events = parts.flatMap((record) => {
    const event = parseRecord(record)
    return event === undefined ? [] : [event]
  })
  return Result.ok({ events, rest })
}

function decodeMessage(event: SseMessageEvent): Result<Message, SseError> {
  const parsed = Result.try<unknown, SseParseError>({
    try: () => JSON.parse(event.data),
    catch: (cause) =>
      new SseParseError({
        cause,
        message: "The event contained invalid JSON",
      }),
  })
  if (parsed.isErr()) {
    return Result.err(
      new SseError({
        cause: parsed.error.cause,
        message: parsed.error.message,
      }),
    )
  }
  const decoded = v.safeParse(messageSchema, parsed.value)
  return decoded.success
    ? Result.ok(decoded.output)
    : Result.err(
        new SseError({
          cause: decoded.issues,
          message: "The event did not match the message contract",
        }),
      )
}

function decodeTopology(event: SseMessageEvent): Result<WorkspaceList, SseError> {
  const parsed = Result.try<unknown, SseParseError>({
    try: () => JSON.parse(event.data),
    catch: (cause) =>
      new SseParseError({
        cause,
        message: "The topology event contained invalid JSON",
      }),
  })
  if (parsed.isErr()) {
    return Result.err(
      new SseError({
        cause: parsed.error.cause,
        message: parsed.error.message,
      }),
    )
  }
  const decoded = v.safeParse(workspaceListSchema, parsed.value)
  return decoded.success
    ? Result.ok(decoded.output)
    : Result.err(
        new SseError({
          cause: decoded.issues,
          message: "The topology event did not match the API contract",
        }),
      )
}

function decodeReceipt(event: SseMessageEvent): Result<ReceiptUpdate, SseError> {
  const parsed = Result.try<unknown, SseParseError>({
    try: () => JSON.parse(event.data),
    catch: (cause) =>
      new SseParseError({
        cause,
        message: "The receipt event contained invalid JSON",
      }),
  })
  if (parsed.isErr()) {
    return Result.err(
      new SseError({
        cause: parsed.error.cause,
        message: parsed.error.message,
      }),
    )
  }
  const decoded = v.safeParse(receiptUpdateSchema, parsed.value)
  return decoded.success
    ? Result.ok(decoded.output)
    : Result.err(
        new SseError({
          cause: decoded.issues,
          message: "The receipt event did not match the API contract",
        }),
      )
}

export class MessageSseClient {
  private readonly options: SseClientOptions
  private readonly handlers: SseHandlers
  private readonly fetchImpl: FetchImplementation
  private readonly retryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly retryJitterMs: number
  private readonly degradedAfterFailures: number
  private readonly degradedRetryDelayMs: number
  private readonly random: () => number
  private readonly stableConnectionMs = 5_000
  private readonly controller = new AbortController()
  private activeController: AbortController | undefined
  private running = false
  private reconnecting = false
  private degraded = false
  private lastEventId: string | undefined

  public constructor(options: SseClientOptions, handlers: SseHandlers) {
    this.options = options
    this.handlers = handlers
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.retryDelayMs = options.retryDelayMs ?? 250
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 4_000
    this.retryJitterMs = Math.max(options.retryJitterMs ?? 250, 0)
    this.degradedAfterFailures = Math.max(options.degradedAfterFailures ?? 3, 1)
    this.degradedRetryDelayMs = Math.max(options.degradedRetryDelayMs ?? 30_000, this.retryDelayMs)
    this.random = options.random ?? Math.random
    this.lastEventId = options.lastEventId
  }

  public start(): Result<void, SseError> {
    if (this.running) {
      return Result.err(
        new SseError({
          cause: undefined,
          message: "The event stream is already running",
        }),
      )
    }
    this.running = true
    void this.run()
    return Result.ok(undefined)
  }

  public close(): void {
    this.running = false
    this.controller.abort()
    this.activeController?.abort()
  }

  public getLastEventId(): string | undefined {
    return this.lastEventId
  }

  private async run(): Promise<void> {
    let delay = this.retryDelayMs
    let consecutiveFailures = 0
    while (this.running) {
      const attemptStartedAt = Date.now()
      const responseResult = await Result.tryPromise<boolean, SseError>({
        try: () => this.openConnection(),
        catch: (cause) =>
          new SseError({
            cause,
            message: "The event stream could not be opened",
          }),
      })

      if (!this.running) return
      const stable = responseResult.isOk() && Date.now() - attemptStartedAt >= this.stableConnectionMs
      if (stable) {
        consecutiveFailures = 0
        delay = this.retryDelayMs
        if (this.degraded) {
          this.degraded = false
          this.handlers.onDegraded?.(false)
        }
      }
      const shouldRetry = responseResult.match({
        ok: (value) => value,
        err: (error) => {
          this.handlers.onError(error)
          return true
        },
      })
      if (!shouldRetry || !this.running) return
      consecutiveFailures += 1
      if (consecutiveFailures >= this.degradedAfterFailures && !this.degraded) {
        this.degraded = true
        this.handlers.onDegraded?.(true)
      }
      const baseDelay = this.degraded ? this.degradedRetryDelayMs : delay
      const jitter = this.retryJitterMs === 0 ? 0 : Math.floor(Math.max(this.random(), 0) * this.retryJitterMs)
      await wait(baseDelay + jitter)
      delay = Math.min(delay * 2, this.maxRetryDelayMs)
      this.reconnecting = true
    }
  }

  private fetchStream(signal: AbortSignal): Promise<Response> {
    const headers = new Headers({ Accept: "text/event-stream" })
    if (this.options.token !== undefined) headers.set("X-Msgr-Token", this.options.token)
    if (this.lastEventId !== undefined) headers.set("Last-Event-ID", this.lastEventId)
    return this.fetchImpl(this.options.url, {
      headers,
      credentials: "include",
      signal,
    })
  }

  private async openConnection(): Promise<boolean> {
    const connectionController = new AbortController()
    const abortConnection = () => connectionController.abort()
    this.activeController = connectionController
    this.controller.signal.addEventListener("abort", abortConnection, { once: true })
    if (this.controller.signal.aborted) connectionController.abort()
    try {
      const response = await this.fetchStream(connectionController.signal)
      if (!this.running) return false
      return await this.consumeResponse(response)
    } finally {
      connectionController.abort()
      this.controller.signal.removeEventListener("abort", abortConnection)
      if (this.activeController === connectionController) this.activeController = undefined
    }
  }

  private async consumeResponse(response: Response): Promise<boolean> {
    if (!response.ok) {
      this.handlers.onError(
        new SseError({
          cause: undefined,
          message: "The event stream returned an error",
          status: response.status,
        }),
      )
      return true
    }
    const body = response.body
    if (body === null) {
      this.handlers.onError(
        new SseError({
          cause: undefined,
          message: "The event stream returned no body",
        }),
      )
      return true
    }

    this.handlers.onOpen(this.reconnecting)
    this.reconnecting = false
    const reader = body.getReader()
    try {
      const decoder = new TextDecoder()
      let buffer = ""
      while (this.running) {
        const readResult = await Result.tryPromise({
          try: () => reader.read(),
          catch: (cause) =>
            new SseError({
              cause,
              message: "The event stream could not be read",
            }),
        })
        const keepReading = readResult.match({
          ok: ({ done, value }) => {
            if (done) return false
            buffer += decoder.decode(value, { stream: true })
            return this.dispatchBuffer(buffer).match({
              ok: (rest) => {
                buffer = rest
                return true
              },
              err: (error) => {
                this.handlers.onError(error)
                return false
              },
            })
          },
          err: (error) => {
            this.handlers.onError(error)
            return false
          },
        })
        if (!keepReading) break
      }
      const finalBuffer = this.dispatchBuffer(buffer, true)
      finalBuffer.match({
        ok: () => undefined,
        err: (error) => this.handlers.onError(error),
      })
    } finally {
      await cancelReader(reader)
    }
    return this.running
  }

  private dispatchBuffer(
    buffer: string,
    flush = false,
  ): Result<string, SseError> {
    const parsed = parseSseRecords(buffer, flush)
    if (parsed.isErr()) {
      return Result.err(
        new SseError({
          cause: parsed.error,
          message: "The event stream could not be parsed",
        }),
      )
    }
    for (const event of parsed.value.events) {
      if (event.id !== undefined) this.lastEventId = event.id
      if (event.event === "topology") {
        const topologyResult = decodeTopology(event)
        if (topologyResult.isErr()) return Result.err(topologyResult.error)
        this.handlers.onTopologySnapshot?.(topologyResult.value, event.id)
        continue
      }
      if (event.event === "receipt") {
        const receiptResult = decodeReceipt(event)
        if (receiptResult.isErr()) return Result.err(receiptResult.error)
        this.handlers.onReceipt?.(receiptResult.value, event.id)
        continue
      }
      const messageResult = decodeMessage(event)
      if (messageResult.isErr()) return Result.err(messageResult.error)
      this.handlers.onMessage(messageResult.value, event.id)
    }
    return Result.ok(parsed.value.rest)
  }
}

/** A reconnecting snapshot stream for live herdr topology. */
export class HerdrSseClient {
  private readonly options: SseClientOptions
  private readonly handlers: TopologySseHandlers
  private readonly fetchImpl: FetchImplementation
  private readonly retryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly controller = new AbortController()
  private activeController: AbortController | undefined
  private running = false
  private reconnecting = false

  public constructor(options: SseClientOptions, handlers: TopologySseHandlers) {
    this.options = options
    this.handlers = handlers
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.retryDelayMs = options.retryDelayMs ?? 250
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 4_000
  }

  public start(): Result<void, SseError> {
    if (this.running) {
      return Result.err(new SseError({ cause: undefined, message: "The topology stream is already running" }))
    }
    this.running = true
    void this.run()
    return Result.ok(undefined)
  }

  public close(): void {
    this.running = false
    this.controller.abort()
    this.activeController?.abort()
  }

  private async run(): Promise<void> {
    let delay = this.retryDelayMs
    while (this.running) {
      const responseResult = await Result.tryPromise<boolean, SseError>({
        try: () => this.openConnection(),
        catch: (cause) => new SseError({ cause, message: "The topology stream could not be opened" }),
      })
      if (!this.running) return
      const shouldRetry = responseResult.match({
        ok: (value) => value,
        err: (error) => {
          this.handlers.onError(error)
          return true
        },
      })
      if (!shouldRetry || !this.running) return
      await wait(delay)
      delay = Math.min(delay * 2, this.maxRetryDelayMs)
      this.reconnecting = true
    }
  }

  private fetchStream(signal: AbortSignal): Promise<Response> {
    const headers = new Headers({ Accept: "text/event-stream" })
    if (this.options.token !== undefined) headers.set("X-Msgr-Token", this.options.token)
    return this.fetchImpl(this.options.url, {
      headers,
      credentials: "include",
      signal,
    })
  }

  private async openConnection(): Promise<boolean> {
    const connectionController = new AbortController()
    const abortConnection = () => connectionController.abort()
    this.activeController = connectionController
    this.controller.signal.addEventListener("abort", abortConnection, { once: true })
    if (this.controller.signal.aborted) connectionController.abort()
    try {
      const response = await this.fetchStream(connectionController.signal)
      if (!this.running) return false
      return await this.consumeResponse(response)
    } finally {
      connectionController.abort()
      this.controller.signal.removeEventListener("abort", abortConnection)
      if (this.activeController === connectionController) this.activeController = undefined
    }
  }

  private async consumeResponse(response: Response): Promise<boolean> {
    if (!response.ok) {
      this.handlers.onError(new SseError({ cause: undefined, message: "The topology stream returned an error", status: response.status }))
      return true
    }
    if (response.body === null) {
      this.handlers.onError(new SseError({ cause: undefined, message: "The topology stream returned no body" }))
      return true
    }
    this.handlers.onOpen(this.reconnecting)
    this.reconnecting = false
    const reader = response.body.getReader()
    try {
      const decoder = new TextDecoder()
      let buffer = ""
      while (this.running) {
        const readResult = await Result.tryPromise({
          try: () => reader.read(),
          catch: (cause) => new SseError({ cause, message: "The topology stream could not be read" }),
        })
        const keepReading = readResult.match({
          ok: ({ done, value }) => {
            if (done) return false
            buffer += decoder.decode(value, { stream: true })
            return this.dispatchBuffer(buffer).match({
              ok: (rest) => {
                buffer = rest
                return true
              },
              err: (error) => {
                this.handlers.onError(error)
                return false
              },
            })
          },
          err: (error) => {
            this.handlers.onError(error)
            return false
          },
        })
        if (!keepReading) break
      }
      this.dispatchBuffer(buffer, true).match({
        ok: () => undefined,
        err: (error) => this.handlers.onError(error),
      })
    } finally {
      await cancelReader(reader)
    }
    return this.running
  }

  private dispatchBuffer(buffer: string, flush = false): Result<string, SseError> {
    const parsed = parseSseRecords(buffer, flush)
    if (parsed.isErr()) return Result.err(new SseError({ cause: parsed.error, message: "The topology stream could not be parsed" }))
    for (const event of parsed.value.events) {
      const decoded = Result.try<unknown, SseError>({
        try: () => JSON.parse(event.data),
        catch: (cause) => new SseError({ cause, message: "The topology event contained invalid JSON" }),
      }).andThen((value) => {
        const result = v.safeParse(workspaceListSchema, value)
        return result.success
          ? Result.ok(result.output)
          : Result.err(new SseError({ cause: result.issues, message: "The topology event did not match the API contract" }))
      })
      if (decoded.isErr()) return Result.err(decoded.error)
      this.handlers.onSnapshot(decoded.value)
    }
    return Result.ok(parsed.value.rest)
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const result = await Result.tryPromise<void, SseError>({
    try: () => reader.cancel(),
    catch: (cause) => new SseError({ cause, message: "The event stream reader could not be closed" }),
  })
  result.match({
    ok: () => undefined,
    err: () => undefined,
  })
  reader.releaseLock()
}
