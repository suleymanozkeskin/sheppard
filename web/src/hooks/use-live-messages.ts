import { useEffect, useMemo, useRef, useState } from "react"

import { apiCall } from "@/api/runtime"
import { formatApiError, type ApiError } from "@/api/errors"
import { mergeMessages } from "@/api/message-merge"
import { SharedMessageSseClient } from "@/api/shared-sse"
import type { Message, MsgrApi, ReceiptUpdate, WorkspaceList } from "@/api/types"

export type MessageLoadState =
  | { status: "loading" }
  | { status: "ready"; errorMessage?: string }

export type StreamState = "connecting" | "live" | "reconnecting" | "degraded" | "offline"

export interface LiveMessagesOptions {
  contextTarget?: { channel: string; messageId: number }
  enableStream?: boolean
  onTopologyDegraded?: (degraded: boolean) => void
  onTopologyError?: () => void
  onTopologyOpen?: (reconnecting: boolean) => void
  onTopologySnapshot?: (snapshot: WorkspaceList) => void
}

export interface LiveMessagesResult {
  messagesByChannel: Map<string, Message[]>
  selectedMessages: Message[]
  messageState: MessageLoadState
  receiptUpdates: ReadonlyMap<string, number>
  receiptUpdatesChannel: string | undefined
  receiptReloadKey: number
  streamState: StreamState
  mergeChannelMessages: (channel: string, messages: Message[]) => void
}

export function useLiveMessages(
  api: MsgrApi,
  fallback: MsgrApi | undefined,
  selectedChannel: string | undefined,
  reloadKey: number,
  onRecovery?: () => void,
  onIncomingMessage?: (message: Message) => void,
  onUnauthorized?: () => void,
  sessionExpired = false,
  options: LiveMessagesOptions = {},
): LiveMessagesResult {
  const [messagesByChannel, setMessagesByChannel] = useState<Map<string, Message[]>>(new Map())
  const [messageState, setMessageState] = useState<MessageLoadState>({ status: "loading" })
  const [receiptUpdates, setReceiptUpdates] = useState<ReadonlyMap<string, number>>(new Map())
  const [receiptReloadKey, setReceiptReloadKey] = useState(0)
  const [streamState, setStreamState] = useState<StreamState>("connecting")
  const buffersRef = useRef(new Map<string, Message[]>())
  const readyChannelsRef = useRef(new Set<string>())
  const selectedChannelRef = useRef(selectedChannel)
  const mountedRef = useRef(true)

  useEffect(() => {
    selectedChannelRef.current = selectedChannel
    setReceiptUpdates(new Map())
  }, [selectedChannel])

  const mergeChannelMessages = useMemo(
    () => (channel: string, incoming: Message[]) => {
      setMessagesByChannel((previous) => {
        const next = new Map(previous)
        next.set(channel, mergeMessages(previous.get(channel) ?? [], incoming))
        return next
      })
    },
    [],
  )

  const loadSnapshot = useMemo(
    () => (channel: string | undefined, catchUp: boolean) => {
      if (channel === undefined || sessionExpired) return
      if (!catchUp) setMessageState({ status: "loading" })
      readyChannelsRef.current.delete(channel)
      if (!buffersRef.current.has(channel)) buffersRef.current.set(channel, [])
      void apiCall(api, fallback, (client) => client.listMessages(channel)).then((result) => {
        if (!mountedRef.current) return
        result.match({
          ok: ({ messages }) => {
            const buffered = buffersRef.current.get(channel) ?? []
            readyChannelsRef.current.add(channel)
            buffersRef.current.delete(channel)
            setMessagesByChannel((previous) => {
              const next = new Map(previous)
              next.set(channel, mergeMessages(messages, buffered))
              return next
            })
            if (channel === selectedChannelRef.current) setMessageState({ status: "ready" })
          },
          err: (error) => {
            if (isUnauthorized(error)) {
              onUnauthorized?.()
              return
            }
            if (channel === selectedChannelRef.current) {
              setMessageState({ status: "ready", errorMessage: formatApiError(error) })
            }
          },
        })
      })
    },
    [api, fallback, onUnauthorized, sessionExpired],
  )

  const loadContext = useMemo(
    () => (channel: string | undefined, messageId: number | undefined) => {
      if (channel === undefined || messageId === undefined || sessionExpired) return
      setMessageState({ status: "loading" })
      readyChannelsRef.current.delete(channel)
      if (!buffersRef.current.has(channel)) buffersRef.current.set(channel, [])
      void apiCall(api, fallback, (client) =>
        client.context(channel, { around: messageId, span: 20 }),
      ).then((result) => {
        if (!mountedRef.current) return
        result.match({
          ok: ({ messages }) => {
            const buffered = buffersRef.current.get(channel) ?? []
            readyChannelsRef.current.add(channel)
            buffersRef.current.delete(channel)
            setMessagesByChannel((previous) => {
              const next = new Map(previous)
              next.set(channel, mergeMessages(messages, buffered))
              return next
            })
            if (channel === selectedChannelRef.current) setMessageState({ status: "ready" })
          },
          err: (error) => {
            if (isUnauthorized(error)) {
              onUnauthorized?.()
              return
            }
            if (channel === selectedChannelRef.current) {
              setMessageState({ status: "ready", errorMessage: formatApiError(error) })
            }
          },
        })
      })
    },
    [api, fallback, onUnauthorized, sessionExpired],
  )

  const loadSnapshotRef = useRef(loadSnapshot)
  const loadContextRef = useRef(loadContext)
  const onIncomingMessageRef = useRef(onIncomingMessage)
  const onRecoveryRef = useRef(onRecovery)
  const onTopologyDegradedRef = useRef(options.onTopologyDegraded)
  const onTopologyErrorRef = useRef(options.onTopologyError)
  const onTopologyOpenRef = useRef(options.onTopologyOpen)
  const onTopologySnapshotRef = useRef(options.onTopologySnapshot)
  const contextTargetRef = useRef(options.contextTarget)
  const contextTargetChannel = options.contextTarget?.channel
  const contextTargetMessageId = options.contextTarget?.messageId

  useEffect(() => {
    loadSnapshotRef.current = loadSnapshot
    loadContextRef.current = loadContext
    onIncomingMessageRef.current = onIncomingMessage
    onRecoveryRef.current = onRecovery
    onTopologyDegradedRef.current = options.onTopologyDegraded
    onTopologyErrorRef.current = options.onTopologyError
    onTopologyOpenRef.current = options.onTopologyOpen
    onTopologySnapshotRef.current = options.onTopologySnapshot
    contextTargetRef.current = contextTargetChannel === undefined || contextTargetMessageId === undefined
      ? undefined
      : { channel: contextTargetChannel, messageId: contextTargetMessageId }
  }, [contextTargetChannel, contextTargetMessageId, loadContext, loadSnapshot, onIncomingMessage, onRecovery, options.onTopologyDegraded, options.onTopologyError, options.onTopologyOpen, options.onTopologySnapshot])

  useEffect(() => {
    if (options.enableStream === false) return
    mountedRef.current = true
    const stream = new SharedMessageSseClient(
      { degradedAfterFailures: 3, degradedRetryDelayMs: 30_000, retryJitterMs: 250, url: "/api/events" },
      {
        onOpen: (reconnecting) => {
          if (!mountedRef.current) return
          setStreamState("live")
          onTopologyOpenRef.current?.(reconnecting)
          if (reconnecting) {
            setReceiptReloadKey((current) => current + 1)
            onRecoveryRef.current?.()
            const target = contextTargetRef.current
            if (target !== undefined && target.channel === selectedChannelRef.current) {
              loadContextRef.current(target.channel, target.messageId)
            } else {
              loadSnapshotRef.current(selectedChannelRef.current, true)
            }
          }
        },
        onMessage: (message) => {
          if (!mountedRef.current) return
          onIncomingMessageRef.current?.(message)
          if (!readyChannelsRef.current.has(message.channel)) {
            const buffered = buffersRef.current.get(message.channel) ?? []
            buffersRef.current.set(message.channel, mergeMessages(buffered, [message]))
            return
          }
          mergeChannelMessages(message.channel, [message])
        },
        onReceipt: (receipt: ReceiptUpdate) => {
          if (receipt.channel !== selectedChannelRef.current) return
          setReceiptUpdates((previous) => {
            const priorCursor = previous.get(receipt.handle)
            if (priorCursor !== undefined && priorCursor >= receipt.cursorMessageId) return previous
            const next = new Map(previous)
            next.set(receipt.handle, receipt.cursorMessageId)
            return next
          })
        },
        onTopologySnapshot: (snapshot) => {
          if (mountedRef.current) onTopologySnapshotRef.current?.(snapshot)
        },
        onError: () => {
          if (!mountedRef.current) return
          setStreamState("reconnecting")
          onTopologyErrorRef.current?.()
        },
        onDegraded: (degraded) => {
          if (!mountedRef.current) return
          setStreamState(degraded ? "degraded" : "reconnecting")
          onTopologyDegradedRef.current?.(degraded)
        },
        onState: (state) => {
          if (mountedRef.current) setStreamState(state)
        },
        onUnavailable: () => {
          if (mountedRef.current) setStreamState("offline")
        },
      },
    )
    const started = stream.start()
    started.match({
      ok: () => undefined,
      err: () => setStreamState("offline"),
    })

    return () => {
      mountedRef.current = false
      stream.close()
    }
  }, [mergeChannelMessages, options.enableStream])

  useEffect(() => {
    if (selectedChannel === undefined) return
    if (contextTargetChannel === undefined || contextTargetMessageId === undefined) {
      loadSnapshot(selectedChannel, false)
      return
    }
    if (contextTargetChannel === selectedChannel) loadContext(contextTargetChannel, contextTargetMessageId)
  }, [contextTargetChannel, contextTargetMessageId, loadContext, loadSnapshot, reloadKey, selectedChannel, sessionExpired])

  return {
    messagesByChannel,
    receiptUpdates: selectedChannel === undefined ? EMPTY_RECEIPT_UPDATES : receiptUpdates,
    receiptUpdatesChannel: selectedChannel,
    receiptReloadKey,
    selectedMessages: selectedChannel === undefined ? [] : messagesByChannel.get(selectedChannel) ?? [],
    messageState,
    streamState,
    mergeChannelMessages,
  }
}

const EMPTY_RECEIPT_UPDATES: ReadonlyMap<string, number> = new Map()

function isUnauthorized(error: ApiError): boolean {
  return error.match({
    ApiNetworkError: () => false,
    ApiHttpError: (failure) => failure.status === 401,
    ApiDecodeError: () => false,
    ApiNotFoundError: () => false,
    ApiConflictError: () => false,
  })
}
