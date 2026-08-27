import { Result, TaggedError } from "better-result"
import ReactMarkdown from "react-markdown"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react"
import {
  CalendarDays,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  MessageCircle,
  X,
} from "lucide-react"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Marker,
  MarkerContent,
} from "@/components/ui/marker"
import {
  Message as MessagePrimitive,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { useMessageScroller, useMessageScrollerVisibility } from "@/components/ui/message-scroller-hooks"
import { highestContiguousVisibleId, type AckScheduler } from "@/api/ack"
import { formatApiError } from "@/api/errors"
import { cn } from "@/lib/utils"
import type { ApiResult, AttachmentMeta, ChannelReceipt, Message, MsgrApi, RouteState } from "@/api/types"
import { AgentAvatar } from "@/components/agent-avatar"
import { Button } from "@/components/ui/button"
import { useChannelReceipts } from "@/hooks/use-channel-receipts"
import { firstUnreadMessageId } from "@/message-unread"
import { useKeyboardLayer } from "@/hooks/use-keyboard-dispatcher"
import { deriveMessageReceiptState, formatReceiptSummary, latestOwnMessageId, type MessageReceiptState } from "@/seen"

type ChannelLoadState = "loading" | "ready"

export interface ChannelViewProps {
  channelName: string
  messages: Message[]
  unread: number
  viewerCursorId?: number
  loadState: ChannelLoadState
  errorMessage?: string
  attachmentContentUrl: (id: number) => string
  fetchAttachmentContent: (id: number) => ApiResult<string>
  canPreview: boolean
  ackScheduler?: AckScheduler
  canAcknowledge?: boolean
  onJoin?: () => void
  onRetry?: () => void
  selfHandle?: string
  focusedMessageId?: number
  onFocusedMessageChange?: (messageId: number) => void
  onStartDirect?: (handle: string) => void
  messageableHandles?: ReadonlySet<string>
  receiptApi?: MsgrApi
  receiptFallbackApi?: MsgrApi
  receiptUpdates?: ReadonlyMap<string, number>
  receiptUpdatesChannel?: string
  receiptRouteStates?: ReadonlyMap<string, RouteState>
  receiptReloadKey?: number
}

class ClipboardError extends TaggedError("ClipboardError")<{
  message: string
  cause: unknown
}> {}

class MarkdownUrlError extends TaggedError("MarkdownUrlError")<{
  message: string
  cause: unknown
}> {}

type CopyState = "idle" | "copied" | "failed"
type PreviewState = "loading" | "ready" | "failed"

async function copyPath(path: string): Promise<Result<void, ClipboardError>> {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard === undefined) {
    return Result.err(
      new ClipboardError({
        cause: undefined,
        message: "Clipboard access is not available",
      }),
    )
  }
  return Result.tryPromise<void, ClipboardError>({
    try: () => clipboard.writeText(path),
    catch: (cause) =>
      new ClipboardError({
        cause,
        message: "The attachment path could not be copied",
      }),
  })
}

export function ChannelView({
  channelName,
  messages,
  unread,
  loadState,
  errorMessage,
  attachmentContentUrl,
  fetchAttachmentContent,
  canPreview,
  ackScheduler,
  selfHandle,
  focusedMessageId,
  onFocusedMessageChange,
  onStartDirect,
  messageableHandles,
  canAcknowledge,
  onJoin,
  onRetry,
  viewerCursorId,
  receiptApi,
  receiptFallbackApi,
  receiptUpdates,
  receiptUpdatesChannel,
  receiptRouteStates,
  receiptReloadKey,
}: ChannelViewProps) {
  const scrollPositionsRef = useRef(new Map<string, number>())
  const receipts = useChannelReceipts(
    receiptApi,
    receiptFallbackApi,
    channelName,
    selfHandle !== undefined && canAcknowledge !== false,
    receiptUpdates,
    receiptUpdatesChannel,
    receiptRouteStates,
    receiptReloadKey,
  )
  return (
    <MessageScrollerProvider defaultScrollPosition="end">
      <ChannelScroller
        attachmentContentUrl={attachmentContentUrl}
        fetchAttachmentContent={fetchAttachmentContent}
        canPreview={canPreview}
        ackScheduler={ackScheduler}
        canAcknowledge={canAcknowledge}
        onJoin={onJoin}
        onRetry={onRetry}
        channelName={channelName}
        errorMessage={errorMessage}
        focusedMessageId={focusedMessageId}
        loadState={loadState}
        messages={messages}
        onFocusedMessageChange={onFocusedMessageChange}
        onStartDirect={onStartDirect}
        messageableHandles={messageableHandles}
        selfHandle={selfHandle}
        unread={unread}
        viewerCursorId={viewerCursorId}
        receipts={receipts}
        scrollPositionsRef={scrollPositionsRef}
      />
    </MessageScrollerProvider>
  )
}

interface ChannelScrollerProps {
  channelName: string
  attachmentContentUrl: (id: number) => string
  fetchAttachmentContent: (id: number) => ApiResult<string>
  canPreview: boolean
  ackScheduler: AckScheduler | undefined
  canAcknowledge: boolean | undefined
  errorMessage: string | undefined
  focusedMessageId: number | undefined
  loadState: ChannelLoadState
  messages: Message[]
  onFocusedMessageChange: ((messageId: number) => void) | undefined
  onStartDirect: ((handle: string) => void) | undefined
  messageableHandles: ReadonlySet<string> | undefined
  onJoin: (() => void) | undefined
  onRetry: (() => void) | undefined
  selfHandle: string | undefined
  unread: number
  viewerCursorId: number | undefined
  receipts: readonly ChannelReceipt[]
  scrollPositionsRef: MutableRefObject<Map<string, number>>
}

function ChannelScroller({
  channelName,
  attachmentContentUrl,
  fetchAttachmentContent,
  canPreview,
  ackScheduler,
  canAcknowledge,
  errorMessage,
  focusedMessageId,
  loadState,
  messages,
  onFocusedMessageChange,
  onStartDirect,
  messageableHandles,
  onJoin,
  onRetry,
  selfHandle,
  unread,
  viewerCursorId,
  receipts,
  scrollPositionsRef,
}: ChannelScrollerProps) {
  const firstUnreadId = firstUnreadMessageId(messages, unread, selfHandle, viewerCursorId)
  const lastOwnMessageId = latestOwnMessageId(messages, selfHandle)
  const { scrollToMessage } = useMessageScroller()
  const viewportRef = useRef<HTMLDivElement>(null)
  const previousChannelRef = useRef<string | undefined>(undefined)
  const initializedChannelsRef = useRef(new Set<string>())
  const scrollPositions = scrollPositionsRef.current

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const previousChannel = previousChannelRef.current
    if (previousChannel !== undefined && previousChannel !== channelName) {
      scrollPositions.set(previousChannel, viewport.scrollTop)
    }
    const nextScrollTop = scrollPositions.get(channelName)
    if (nextScrollTop !== undefined) {
      viewport.scrollTop = nextScrollTop
    } else if (messages.length > 0 && !initializedChannelsRef.current.has(channelName)) {
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      initializedChannelsRef.current.add(channelName)
    }
    previousChannelRef.current = channelName
    return () => {
      if (messages.length > 0) scrollPositions.set(channelName, viewport.scrollTop)
    }
  }, [channelName, messages.length, scrollPositions])

  useEffect(() => {
    if (messages.length === 0) return
    const viewport = viewportRef.current
    if (viewport === null) return
    const savedScrollTop = scrollPositions.get(channelName)
    const frame = window.requestAnimationFrame(() => {
      if (savedScrollTop !== undefined) {
        viewport.scrollTop = savedScrollTop
        return
      }
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [channelName, messages.length, scrollPositions])

  useEffect(() => {
    if (focusedMessageId === undefined) return
    scrollToMessage(String(focusedMessageId), { align: "center", behavior: "smooth" })
  }, [focusedMessageId, scrollToMessage])

  const activeFocusedMessageId = focusedMessageId ?? messages[0]?.id
  const keepMessagesMounted = messages.length > 0

  return (
    <>
      <MessageScroller>
        <MessageScrollerViewport ref={viewportRef}>
          <MessageScrollerContent aria-label="Messages" className="gap-2 px-4 py-4 sm:px-8" role="list">
            {loadState === "loading" && !keepMessagesMounted && <ChannelMessagesSkeleton />}
            {loadState === "loading" && keepMessagesMounted && (
              <span className="sr-only" role="status">Refreshing messages</span>
            )}
            {loadState === "ready" && errorMessage !== undefined && (
              <ChannelMessagesError message={errorMessage} onJoin={onJoin} onRetry={onRetry} />
            )}
            {loadState === "ready" && errorMessage === undefined && messages.length === 0 && (
              <Marker className="mx-auto max-w-md" variant="separator">
                <MarkerContent className="px-3 text-center">No messages in this channel.</MarkerContent>
              </Marker>
            )}
            {(loadState === "ready" || keepMessagesMounted) && errorMessage === undefined &&
              messages.map((message, index) => (
                <MessageWithMarkers
                  attachmentContentUrl={attachmentContentUrl}
                  fetchAttachmentContent={fetchAttachmentContent}
                  canPreview={canPreview}
                  unreadMarker={message.id === firstUnreadId ? "first" : "none"}
                  groupState={canGroupMessages(messages[index - 1], message) ? "grouped" : "standalone"}
                  focusState={focusedMessageId !== undefined && message.id === activeFocusedMessageId
                    ? "requested"
                    : message.id === activeFocusedMessageId ? "focused" : "unfocused"}
                  key={message.id}
                  message={message}
                  previousMessage={messages[index - 1]}
                  onFocusedMessageChange={onFocusedMessageChange}
                  onStartDirect={onStartDirect}
                  messageableHandles={messageableHandles}
                  receiptState={message.id === lastOwnMessageId && selfHandle !== undefined
                    ? deriveMessageReceiptState(receipts, message.id, selfHandle)
                    : undefined}
                  selfHandle={selfHandle}
                />
              ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
      {ackScheduler !== undefined && canAcknowledge !== false && (
        <ChannelReadTracker channelName={channelName} messages={messages} ackScheduler={ackScheduler} />
      )}
    </>
  )
}

interface ChannelReadTrackerProps {
  channelName: string
  messages: Message[]
  ackScheduler: AckScheduler
}

function ChannelReadTracker({ channelName, messages, ackScheduler }: ChannelReadTrackerProps) {
  const { visibleMessageIds } = useMessageScrollerVisibility()

  useEffect(() => {
    const throughId = highestContiguousVisibleId(messages, visibleMessageIds)
    if (throughId !== undefined) ackScheduler.enqueue(channelName, throughId)
  }, [ackScheduler, channelName, messages, visibleMessageIds])

  return null
}

interface MessageWithMarkersProps {
  attachmentContentUrl: (id: number) => string
  fetchAttachmentContent: (id: number) => ApiResult<string>
  canPreview: boolean
  unreadMarker: "first" | "none"
  groupState: "grouped" | "standalone"
  focusState: "focused" | "requested" | "unfocused"
  message: Message
  previousMessage: Message | undefined
  onFocusedMessageChange: ((messageId: number) => void) | undefined
  onStartDirect: ((handle: string) => void) | undefined
  messageableHandles: ReadonlySet<string> | undefined
  receiptState: MessageReceiptState | undefined
  selfHandle: string | undefined
}

function MessageWithMarkers({
  attachmentContentUrl,
  fetchAttachmentContent,
  canPreview,
  unreadMarker,
  groupState,
  focusState,
  message,
  previousMessage,
  onFocusedMessageChange,
  onStartDirect,
  messageableHandles,
  receiptState,
  selfHandle,
}: MessageWithMarkersProps) {
  const dateKey = localDateKey(message.createdAt)
  const previousDateKey = previousMessage === undefined ? undefined : localDateKey(previousMessage.createdAt)
  const showDateMarker = previousDateKey !== dateKey
  const isGrouped = groupState === "grouped"
  const isFocused = focusState !== "unfocused"
  const focusMessage = useCallback((element: HTMLDivElement | null) => {
    if (element !== null && focusState === "requested") element.focus()
  }, [focusState])

  return (
    <>
      {showDateMarker && <DateMarker dateKey={dateKey} />}
      {unreadMarker === "first" && <UnreadMarker />}
      <MessageScrollerItem
        className={cn(
          "relative rounded-lg outline-none focus-visible:outline-none before:pointer-events-none before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-primary before:opacity-0",
          isFocused && "bg-muted/50 before:opacity-100",
          isGrouped && "-mt-1",
        )}
        data-message-id={message.id}
        id={`message-${message.id}`}
        messageId={String(message.id)}
        aria-label={`Message from ${message.sender}`}
        ref={focusMessage}
        onFocus={() => onFocusedMessageChange?.(message.id)}
        role="listitem"
        tabIndex={isFocused ? 0 : -1}
      >
        <MessageRow
          attachmentContentUrl={attachmentContentUrl}
          fetchAttachmentContent={fetchAttachmentContent}
          canPreview={canPreview}
          isGrouped={isGrouped}
          message={message}
          selfHandle={selfHandle}
          onStartDirect={onStartDirect}
          messageableHandles={messageableHandles}
          receiptState={receiptState}
        />
      </MessageScrollerItem>
    </>
  )
}

interface MessageRowProps {
  attachmentContentUrl: (id: number) => string
  fetchAttachmentContent: (id: number) => ApiResult<string>
  canPreview: boolean
  isGrouped: boolean
  message: Message
  selfHandle: string | undefined
  onStartDirect: ((handle: string) => void) | undefined
  messageableHandles: ReadonlySet<string> | undefined
  receiptState: MessageReceiptState | undefined
}

function MessageRow({
  attachmentContentUrl,
  fetchAttachmentContent,
  canPreview,
  isGrouped,
  message,
  selfHandle,
  onStartDirect,
  messageableHandles,
  receiptState,
}: MessageRowProps) {
  const isSelf = selfHandle !== undefined && message.sender === selfHandle
  const senderInitial = message.sender.slice(0, 1).toUpperCase()

  return (
    <MessagePrimitive align={isSelf ? "end" : "start"}>
      <MessageAvatar
        aria-hidden={isGrouped || undefined}
        className={cn(
          isSelf ? "bg-primary text-primary-foreground" : "bg-muted",
          isGrouped && "invisible",
        )}
      >
        {message.senderKind === "agent" ? (
          <AgentAvatar agentKind={message.senderAgentKind} />
        ) : (
          <span aria-hidden="true" className="text-xs font-semibold">{senderInitial}</span>
        )}
        <span className="sr-only">{message.sender}</span>
      </MessageAvatar>
      <MessageContent className="gap-1.5">
        {!isGrouped && <MessageHeader>
          <span>{message.sender}</span>
          {onStartDirect !== undefined && message.sender !== selfHandle && messageableHandles?.has(message.sender) === true && (
            <button
              aria-label={`Message ${message.sender} directly`}
              className="ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation()
                onStartDirect(message.sender)
              }}
              title={`Message ${message.sender} directly`}
              type="button"
            >
              <MessageCircle aria-hidden="true" className="size-3.5" />
            </button>
          )}
          <span aria-hidden="true" className="mx-1.5 font-normal text-muted-foreground/70">·</span>
          <span className="font-normal text-muted-foreground/70">
            {message.senderKind === "agent" ? "agent" : "human"}
          </span>
          <span aria-hidden="true" className="mx-1.5 font-normal text-muted-foreground/70">·</span>
          <time className="font-normal text-muted-foreground/70" dateTime={message.createdAt}>
            {formatTime(message.createdAt)}
          </time>
        </MessageHeader>}
        <MessageGroup className="gap-0.5">
          <Bubble align={isSelf ? "end" : "start"} variant={isSelf ? "default" : "secondary"}>
            <BubbleContent className="px-3 py-1">
              <p className="whitespace-pre-wrap break-words">{renderMessageBody(message.body)}</p>
            </BubbleContent>
          </Bubble>
          {message.attachments.length > 0 && (
            <AttachmentGroup className={cn(isSelf && "justify-end")}>
              {message.attachments.map((attachment) => (
                <AttachmentCard
                  attachment={attachment}
                  attachmentContentUrl={attachmentContentUrl}
                  fetchAttachmentContent={fetchAttachmentContent}
                  canPreview={canPreview}
                  key={attachment.id}
                />
              ))}
            </AttachmentGroup>
          )}
          {isSelf && receiptState !== undefined && <MessageReceiptSummary state={receiptState} />}
        </MessageGroup>
      </MessageContent>
    </MessagePrimitive>
  )
}

function MessageReceiptSummary({ state }: { state: MessageReceiptState }) {
  if (!state.hasRecipients) return null
  const summary = formatReceiptSummary(state)
  if (summary.seen) {
    return (
      <p
        className="px-1 text-end text-[11px] text-muted-foreground"
        data-receipt-required="seen"
        data-receipt-state="seen"
      >
        Seen
      </p>
    )
  }
  return (
    <div
      className="flex flex-col items-end gap-0.5 px-1 text-end text-[11px] text-muted-foreground"
      data-receipt-required="missing"
      data-receipt-state="missing"
    >
      {summary.notYet !== undefined && <p data-receipt-kind="not-yet">{summary.notYet}</p>}
      {summary.cannotReceive !== undefined && <p className="text-amber-700 dark:text-amber-400" data-receipt-kind="cannot-receive">{summary.cannotReceive}</p>}
    </div>
  )
}

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000

function canGroupMessages(previous: Message | undefined, current: Message): boolean {
  if (previous === undefined || previous.sender !== current.sender) return false
  if (previous.senderKind !== current.senderKind) return false
  if (localDateKey(previous.createdAt) !== localDateKey(current.createdAt)) return false
  const elapsed = Date.parse(current.createdAt) - Date.parse(previous.createdAt)
  return elapsed >= 0 && elapsed <= MESSAGE_GROUP_WINDOW_MS
}

export interface AttachmentCardProps {
  attachment: AttachmentMeta
  attachmentContentUrl: (id: number) => string
  canCopy?: boolean
  canPreview: boolean
  copyDisabledReason?: string
  fetchAttachmentContent: (id: number) => ApiResult<string>
  actionTabIndex?: number
  showPath?: boolean
}

type ViewerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; content: string }
  | { status: "image" }
  | { status: "error"; message: string }

const VIEWER_KEYBOARD_LAYER = { mode: "inline", scope: "viewer" } as const

export function AttachmentCard({
  attachment,
  attachmentContentUrl,
  actionTabIndex,
  canCopy = true,
  canPreview,
  copyDisabledReason,
  fetchAttachmentContent,
  showPath = true,
}: AttachmentCardProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [previewState, setPreviewState] = useState<PreviewState>("loading")
  const [viewerState, setViewerState] = useState<ViewerState>({ status: "idle" })
  const viewerOpen = viewerState.status === "ready" || viewerState.status === "image"
  const showPreview =
    canPreview && attachment.previewEligible && attachment.previewKind === "image" && previewState !== "failed"

  const handleCopy = useCallback((): void => {
    void copyPath(attachment.path).then((result) => {
      setCopyState(
        result.match({
          ok: () => "copied" as const,
          err: (error) => error.match({ ClipboardError: () => "failed" as const }),
        }),
      )
    })
  }, [attachment.path])

  const handleView = useCallback((): void => {
    if (!attachment.previewEligible || !canPreview || (attachment.previewKind !== "image" && attachment.previewKind !== "markdown")) return
    if (attachment.previewKind === "image") {
      setViewerState((current) => current.status === "image" ? { status: "idle" } : { status: "image" })
      return
    }
    if (viewerState.status === "ready") {
      setViewerState({ status: "idle" })
      return
    }
    setViewerState({ status: "loading" })
    void fetchAttachmentContent(attachment.id).then((result) => {
      result.match({
        ok: (content) => setViewerState({ content, status: "ready" }),
        err: (error) => setViewerState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [attachment.id, attachment.previewEligible, attachment.previewKind, canPreview, fetchAttachmentContent, viewerState.status])
  const closeViewer = useCallback((): void => setViewerState({ status: "idle" }), [])
  const viewerKind = attachment.previewKind === "image" ? "image" : "markdown"

  return (
    <Attachment className="max-w-full" data-attachment-id={attachment.id} orientation="horizontal" size="sm" state="done">
      <AttachmentMedia variant={showPreview ? "image" : "icon"}>
        {showPreview ? (
          <img
            alt={`Preview of ${attachment.displayName}`}
            className="size-full object-cover"
            data-attachment-preview="thumbnail"
            onError={() => setPreviewState("failed")}
            onLoad={() => setPreviewState("ready")}
            src={attachmentContentUrl(attachment.id)}
          />
        ) : attachment.previewKind === "image" ? (
          <ImageIcon aria-hidden="true" />
        ) : (
          <FileText aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.displayName}</AttachmentTitle>
        {showPath && (
          <AttachmentDescription className="flex min-w-0 items-baseline gap-1">
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis [direction:rtl] [text-align:left]" title={attachment.path}>
              {attachmentDirectory(attachment.path)}
            </span>
            <span className="shrink-0" title={attachment.path}>{attachmentBasename(attachment.path)}</span>
            <span className="shrink-0">· {formatByteSize(attachment.byteSize)}</span>
          </AttachmentDescription>
        )}
      </AttachmentContent>
      <AttachmentActions>
        {canPreview && attachment.previewEligible && (attachment.previewKind === "image" || attachment.previewKind === "markdown") && (
          <AttachmentAction
            aria-label={`${viewerOpen ? "Hide" : "View"} ${attachment.displayName}`}
            data-attachment-action="view"
            onClick={handleView}
            tabIndex={actionTabIndex}
            title={`${viewerOpen ? "Hide" : "View"} ${viewerKind}`}
          >
            {viewerOpen ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </AttachmentAction>
        )}
        {viewerState.status !== "idle" && (
          <AttachmentAction
            aria-label={`Close ${viewerKind} viewer`}
            data-attachment-action="close-viewer"
            onClick={closeViewer}
            tabIndex={actionTabIndex}
            title={`Close ${viewerKind} viewer`}
          >
            <X aria-hidden="true" />
          </AttachmentAction>
        )}
        <AttachmentAction
          aria-label={`Copy path for ${attachment.displayName}`}
          data-attachment-action="copy"
          disabled={!canCopy}
          onClick={handleCopy}
          tabIndex={actionTabIndex}
          title={!canCopy ? copyDisabledReason : copyState === "copied" ? "Copied" : "Copy path"}
        >
          {copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </AttachmentAction>
      </AttachmentActions>
      {copyState === "failed" && (
        <span className="sr-only" role="status">
          Copy failed
        </span>
      )}
      {viewerState.status === "loading" && (
        <p className="basis-full border-t px-3 py-2 text-xs text-muted-foreground">Loading markdown…</p>
      )}
      {viewerState.status === "error" && (
        <p className="basis-full border-t px-3 py-2 text-xs text-destructive" data-surface-kind="error-text" role="alert">
          {viewerState.message}
        </p>
      )}
      {previewState === "failed" && viewerState.status !== "image" && (
        <p className="basis-full border-t px-3 py-2 text-xs text-destructive" data-surface-kind="error-text" role="status">
          This file is no longer available.
        </p>
      )}
      {viewerState.status === "image" && (
        <div className="basis-full border-t px-3 py-3" data-attachment-viewer-kind="image">
          {showPreview ? (
            <img
              alt={`Preview of ${attachment.displayName}`}
              className="max-h-[32rem] max-w-full rounded-lg object-contain"
              data-attachment-preview="viewer"
              onError={() => setPreviewState("failed")}
              onLoad={() => setPreviewState("ready")}
              src={attachmentContentUrl(attachment.id)}
            />
          ) : (
            <p className="text-xs text-destructive" data-surface-kind="error-text" role="status">
              This file is no longer available.
            </p>
          )}
        </div>
      )}
      {viewerState.status === "ready" && (
        <div className="md-view prose basis-full max-w-[68ch] border-t px-3 py-3 text-foreground">
          <ReactMarkdown
            components={{
              a: ({ children, href }) => (
                <a href={href} rel="noreferrer" target="_blank">
                  {children}
                </a>
              ),
            }}
            skipHtml
            urlTransform={safeMarkdownUrl}
          >
            {viewerState.content}
          </ReactMarkdown>
        </div>
      )}
      {viewerOpen && <AttachmentViewerLayer onClose={closeViewer} />}
    </Attachment>
  )
}

function AttachmentViewerLayer({ onClose }: { onClose: () => void }) {
  useKeyboardLayer(VIEWER_KEYBOARD_LAYER, undefined, onClose)
  return null
}

function safeMarkdownUrl(url: string): string {
  const parsed = Result.try<URL, MarkdownUrlError>({
    try: () => new URL(url),
    catch: (cause) => new MarkdownUrlError({ cause, message: "The markdown URL is invalid" }),
  })
  return parsed.match({
    ok: (value) =>
      value.protocol === "http:" || value.protocol === "https:" || value.protocol === "mailto:"
        ? value.toString()
        : "",
    err: () => "",
  })
}

function DateMarker({ dateKey }: { dateKey: string }) {
  return (
    <Marker className="my-2" variant="separator">
      <MarkerContent className="inline-flex items-center gap-1.5 px-3">
        <CalendarDays className="size-3.5" aria-hidden="true" />
        {formatDateMarker(dateKey)}
      </MarkerContent>
    </Marker>
  )
}

function UnreadMarker() {
  return (
    <Marker className="my-2 text-primary before:bg-primary after:bg-primary" variant="separator">
      <MarkerContent className="px-3 font-medium">Unread messages</MarkerContent>
    </Marker>
  )
}

function ChannelMessagesSkeleton() {
  return (
    <div aria-label="Loading messages" className="space-y-4 py-4">
      <div className="h-20 w-2/3 animate-pulse rounded-xl bg-muted" />
      <div className="ml-auto h-16 w-1/2 animate-pulse rounded-xl bg-muted" />
      <div className="h-24 w-3/4 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function ChannelMessagesError({ message, onJoin, onRetry }: { message: string; onJoin: (() => void) | undefined; onRetry: (() => void) | undefined }) {
  const nonMember = message.toLocaleLowerCase().includes("not a member") || message.toLocaleLowerCase().includes("have not joined")
  return (
    <Marker className="mx-auto max-w-md text-destructive" variant="separator">
      <MarkerContent className="inline-flex flex-wrap items-center justify-center gap-2 px-3 text-center" role="alert">
        {message}
        {nonMember && onJoin !== undefined && <Button onClick={onJoin} size="sm" type="button" variant="outline">Join</Button>}
        {!nonMember && onRetry !== undefined && <Button onClick={onRetry} size="sm" type="button" variant="outline">Try again</Button>}
      </MarkerContent>
    </Marker>
  )
}

function formatDateMarker(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number)
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1)
  return date.toLocaleDateString(undefined, { dateStyle: "medium" })
}

function localDateKey(timestamp: string): string {
  const date = new Date(timestamp)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-")
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
}

function formatByteSize(byteSize: number | null): string {
  if (byteSize === null) return "size unknown"
  if (byteSize < 1_000) return `${byteSize} B`
  if (byteSize < 1_000_000) return `${(byteSize / 1_000).toFixed(1)} KB`
  return `${(byteSize / 1_000_000).toFixed(1)} MB`
}

const MESSAGE_TOKEN_PATTERN = /(`[^`\n]+`|\/(?:[A-Za-z0-9._~!$&'()*+,;=@%/-]+)|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?::\d+(?:-\d+)?)?|[0-9a-f]{7,40})/giu

function renderMessageBody(body: string): ReactNode {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of body.matchAll(MESSAGE_TOKEN_PATTERN)) {
    const token = match[0]
    const start = match.index
    if (start === undefined) continue
    if (start > cursor) nodes.push(body.slice(cursor, start))
    const value = token.startsWith("`") && token.endsWith("`") ? token.slice(1, -1) : token
    nodes.push(
      <button
        className="rounded bg-primary-foreground px-1 font-mono text-[13px] text-primary hover:bg-primary-foreground/80"
        data-surface-kind="code-chip"
        key={`${start}-${token}`}
        onClick={() => { void copyPath(value) }}
        title="Copy reference"
        type="button"
      >
        <code>{value}</code>
      </button>,
    )
    cursor = start + token.length
  }
  if (cursor < body.length) nodes.push(body.slice(cursor))
  return nodes.length === 0 ? body : nodes
}

function attachmentBasename(path: string): string {
  const separator = path.lastIndexOf("/")
  return separator < 0 ? path : path.slice(separator + 1)
}

function attachmentDirectory(path: string): string {
  const separator = path.lastIndexOf("/")
  return separator < 0 ? "" : path.slice(0, separator + 1)
}
