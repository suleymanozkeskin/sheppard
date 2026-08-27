import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { File, FileText, Image as ImageIcon, Paperclip } from "lucide-react"

import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import { apiCall } from "@/api/runtime"
import { formatApiError } from "@/api/errors"
import type { AttachmentListKind, AttachmentListRow, MsgrApi } from "@/api/types"
import { isPageLevelFocus } from "@/attachments-focus"
import { AttachmentCard } from "@/components/channel-view"
import { Button } from "@/components/ui/button"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { useKeyboardLayer } from "@/hooks/use-keyboard-dispatcher"
import { isModifierCombo, type KeyEventLike } from "@/keyboard"
import { relativeAgeLabel, absoluteTimeLabel } from "@/workspace-presentation"
import type { AttachmentRouteKind, AttachmentRouteScope, ShellNavigate } from "@/shell-routing"

const ATTACHMENT_LIST_LIMIT = 50
const ATTACHMENT_KEYBOARD_LAYER = { mode: "inline", scope: "attachments" } as const
const NO_ATTACHMENT_ROWS: readonly AttachmentListRow[] = []

type AttachmentLoadState =
  | { status: "loading" }
  | { status: "ready"; rows: AttachmentListRow[]; truncated: boolean }
  | { status: "error"; message: string }

function isChannelScope(value: string): value is `channel:${string}` {
  return value.startsWith("channel:") && value.length > "channel:".length
}

type AttachmentScopeOption = Omit<ComboboxOption, "value"> & { value: AttachmentRouteScope }

function isAttachmentScope(value: string): value is AttachmentRouteScope {
  return value === "all" || isChannelScope(value)
}

function attachmentScopeFromCombobox(value: string | null, options: readonly AttachmentScopeOption[]): AttachmentRouteScope | undefined {
  if (value === null || !isAttachmentScope(value)) return undefined
  return options.some((option) => option.value === value) ? value : undefined
}

export interface AttachmentsPageProps {
  api: MsgrApi
  attachmentKind: AttachmentRouteKind
  availableChannels: readonly string[]
  canWrite: boolean
  canPreview: boolean
  fallbackApi?: MsgrApi
  navigate: ShellNavigate
  scope: AttachmentRouteScope
}

export function AttachmentsPage({
  api,
  attachmentKind,
  availableChannels,
  canWrite,
  canPreview,
  fallbackApi,
  navigate,
  scope,
}: AttachmentsPageProps) {
  const [state, setState] = useState<AttachmentLoadState>({ status: "loading" })
  const [activeIndex, setActiveIndex] = useState(0)
  const [copyNotice, setCopyNotice] = useState<string | undefined>()
  const [menuRow, setMenuRow] = useState<AttachmentListRow | undefined>()
  const requestIdRef = useRef(0)
  const focusFirstRef = useRef(true)
  const pendingMenuFocusRef = useRef<number | undefined>(undefined)
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const channel = scope.startsWith("channel:") ? scope.slice("channel:".length) : undefined
  const rows = state.status === "ready" ? state.rows : NO_ATTACHMENT_ROWS
  const truncated = state.status === "ready" && state.truncated

  const load = useCallback(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    focusFirstRef.current = true
    setActiveIndex(0)
    setState({ status: "loading" })
    const kind: AttachmentListKind | undefined = attachmentKind === "all" ? undefined : attachmentKind
    void apiCall(api, fallbackApi, (client) => client.listAttachments({ channel, kind, limit: ATTACHMENT_LIST_LIMIT })).then((result) => {
      if (requestId !== requestIdRef.current) return
      result.match({
        ok: ({ rows: nextRows, truncated: nextTruncated }) => setState({ rows: nextRows, status: "ready", truncated: nextTruncated }),
        err: (error) => setState({ message: formatApiError(error), status: "error" }),
      })
    })
  }, [api, attachmentKind, channel, fallbackApi])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (state.status !== "ready") return
    const maxIndex = Math.max(rows.length - 1, 0)
    setActiveIndex((current) => Math.min(current, maxIndex))
    if (!focusFirstRef.current) return
    focusFirstRef.current = false
    const frame = globalThis.requestAnimationFrame(() => {
      const first = rows[0]
      if (first === undefined) return
      const activeElement = globalThis.document?.activeElement
      if (!isPageLevelFocus(activeElement, globalThis.document?.body, globalThis.document?.documentElement)) return
      rowRefs.current.get(first.attachment.id)?.focus()
    })
    return () => globalThis.cancelAnimationFrame(frame)
  }, [rows, state.status])

  useLayoutEffect(() => {
    if (menuRow !== undefined) return
    const attachmentId = pendingMenuFocusRef.current
    if (attachmentId === undefined) return
    pendingMenuFocusRef.current = undefined
    rowRefs.current.get(attachmentId)?.focus()
  }, [menuRow])

  const moveActive = useCallback((delta: number) => {
    if (rows.length === 0) return
    const next = (activeIndex + delta + rows.length) % rows.length
    setActiveIndex(next)
    const row = rows[next]
    if (row === undefined) return
    globalThis.requestAnimationFrame(() => rowRefs.current.get(row.attachment.id)?.focus())
  }, [activeIndex, rows])

  const navigateToMessage = useCallback((row: AttachmentListRow) => {
    navigate({
      channel: row.channel,
      kind: row.channel.startsWith("dm-") ? "conversation" : "channel",
      messageId: row.messageId,
    })
  }, [navigate])

  const openPreview = useCallback((row: AttachmentListRow) => {
    const viewButton = rowRefs.current.get(row.attachment.id)?.querySelector<HTMLButtonElement>('[data-attachment-action="view"]')
    viewButton?.click()
  }, [])

  const closeMenuAndFocusRow = useCallback((row: AttachmentListRow) => {
    pendingMenuFocusRef.current = row.attachment.id
    setMenuRow(undefined)
  }, [])

  const openRow = useCallback((row: AttachmentListRow) => {
    if (canPreview && row.attachment.previewEligible && (row.attachment.previewKind === "image" || row.attachment.previewKind === "markdown")) {
      openPreview(row)
      return
    }
    navigateToMessage(row)
  }, [canPreview, navigateToMessage, openPreview])

  const copyRowPath = useCallback((row: AttachmentListRow) => {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard === undefined) {
      setCopyNotice("Clipboard access is not available.")
      return
    }
    void clipboard.writeText(row.attachment.path).then(
      () => setCopyNotice("Attachment path copied."),
      () => setCopyNotice("The attachment path could not be copied."),
    )
  }, [])

  const handleLayerKeyDown = useCallback((event: KeyEventLike): boolean => {
    const activeElement = globalThis.document?.activeElement
    if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLSelectElement || activeElement instanceof HTMLTextAreaElement) return false
    if (isModifierCombo(event)) return false
    if (event.key === "j" || event.key === "ArrowDown") {
      moveActive(1)
      return true
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      moveActive(-1)
      return true
    }
    if (event.key === ".") {
      const row = rows[activeIndex]
      if (row === undefined) return false
      setMenuRow(row)
      return true
    }
    if (event.key === "y") {
      const row = rows[activeIndex]
      if (row === undefined) return false
      copyRowPath(row)
      return true
    }
    if (event.key === "Enter") {
      const row = rows[activeIndex]
      if (row !== undefined) openRow(row)
      return row !== undefined
    }
    return false
  }, [activeIndex, copyRowPath, moveActive, openRow, rows])

  const closePage = useCallback(() => navigate({ kind: "current" }), [navigate])
  useKeyboardLayer(ATTACHMENT_KEYBOARD_LAYER, handleLayerKeyDown, closePage)

  const changeScope = useCallback((nextScope: AttachmentRouteScope) => {
    navigate({ attachmentKind, kind: "attachments", scope: nextScope }, true)
  }, [attachmentKind, navigate])

  const changeKind = useCallback((nextKind: AttachmentRouteKind) => {
    navigate({ attachmentKind: nextKind, kind: "attachments", scope }, true)
  }, [navigate, scope])

  const channelOptions = [...new Set([
    ...availableChannels,
    ...(channel === undefined ? [] : [channel]),
  ])].toSorted((left, right) => left.localeCompare(right))
  const scopeOptions: AttachmentScopeOption[] = [
    { label: "All channels", value: "all" },
    ...channelOptions.map((option): AttachmentScopeOption => ({
      keywords: [option],
      label: displayChannelLabel(option),
      value: `channel:${option}`,
    })),
  ]
  const kindOptions: { label: string; value: AttachmentRouteKind }[] = [
    { label: "All file types", value: "all" },
    { label: "Images", value: "image" },
    { label: "Markdown", value: "markdown" },
    { label: "Other files", value: "other" },
  ]

  return (
    <div className="flex min-h-full w-full flex-col" data-attachments-view>
      <div className="border-b px-4 py-3 sm:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-[1_1_12rem] sm:w-56 sm:flex-none" data-scope-filter={scope}>
            <Combobox
              className="w-full"
              id="attachments-scope"
              label="Channel scope"
              options={scopeOptions}
              placeholder="Search channels…"
              required
              showAllOption={false}
              value={scope}
              onEscapeWhenClosed={closePage}
              onValueChange={(value) => {
                const nextScope = attachmentScopeFromCombobox(value, scopeOptions)
                if (nextScope === undefined) return
                changeScope(nextScope)
              }}
            />
          </div>
          <div aria-label="File type" className="grid min-w-0 flex-[1_1_20rem] grid-cols-4 rounded-lg border bg-muted/40 p-1 sm:flex-none" data-kind-filter={attachmentKind} role="group">
            {kindOptions.map((option) => (
              <button aria-pressed={attachmentKind === option.value} className="min-h-9 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3 sm:text-sm" key={option.value} onClick={() => changeKind(option.value)} type="button">{option.label}</button>
            ))}
          </div>
          <p className="ml-auto text-xs text-muted-foreground" data-attachment-count data-attachment-truncated={truncated ? "true" : "false"} role="status">
            {state.status === "ready" ? `${rows.length} file${rows.length === 1 ? "" : "s"} shown` : ""}
            {truncated && " · more may exist — refine the filters"}
          </p>
        </div>
        {!canWrite && <p className="mt-2 text-xs text-muted-foreground" data-attachment-identity role="status">{NOT_CONNECTED_REASON}</p>}
        {copyNotice !== undefined && <p className="mt-2 text-xs text-muted-foreground" data-attachment-copy-state role="status">{copyNotice}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {state.status === "loading" && (
          <div aria-label="Loading attachments" className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" data-attachment-state="loading" role="status">
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
          </div>
        )}
        {state.status === "error" && (
          <div className="mx-auto max-w-md rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-center" data-attachment-state="error" role="alert">
            <p className="text-sm text-destructive">{state.message}</p>
            <Button className="mt-3" onClick={load} size="sm" type="button" variant="outline">Try again</Button>
          </div>
        )}
        {state.status === "ready" && rows.length === 0 && (
          <div className="mx-auto max-w-md rounded-xl border border-dashed p-6 text-center" data-attachment-state="empty">
            <Paperclip aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No files have been shared.</p>
            <p className="mt-1 text-xs text-muted-foreground">Attach a file by absolute path from any composer.</p>
          </div>
        )}
        {state.status === "ready" && rows.length > 0 && (
          <ol aria-label="Attachments" className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3" data-attachment-list>
            {rows.map((row, index) => {
              const active = index === activeIndex
              return (
                <li key={`${row.channel}:${row.messageId}:${row.attachment.id}`}>
                  <div
                    aria-label={`${row.attachment.displayName} shared by ${row.sender}`}
                    className="relative rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    data-active={active ? "true" : undefined}
                    data-attachment-path={row.attachment.path}
                    data-attachment-row={row.attachment.id}
                    onClick={(event) => {
                      if (event.target instanceof Element && event.target.closest("[data-attachment-action], [data-attachment-menu]")) return
                      setActiveIndex(index)
                      openRow(row)
                    }}
                    onFocus={() => setActiveIndex(index)}
                    ref={(element) => {
                      if (element === null) rowRefs.current.delete(row.attachment.id)
                      else rowRefs.current.set(row.attachment.id, element)
                    }}
                    role="listitem"
                    tabIndex={active ? 0 : -1}
                  >
                    {menuRow?.attachment.id === row.attachment.id && (
                      <AttachmentRowMenu
                        canView={canPreview && row.attachment.previewEligible && (row.attachment.previewKind === "image" || row.attachment.previewKind === "markdown")}
                        onClose={() => closeMenuAndFocusRow(row)}
                        onCopy={() => {
                          copyRowPath(row)
                          closeMenuAndFocusRow(row)
                        }}
                        onGoToMessage={() => {
                          navigateToMessage(row)
                          setMenuRow(undefined)
                        }}
                        onView={() => {
                          openPreview(row)
                          closeMenuAndFocusRow(row)
                        }}
                      />
                    )}
                    <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-attachment-metadata>
                      <span className="min-w-0 truncate font-medium text-foreground">{row.sender}</span>
                      <span aria-hidden="true">·</span>
                      <button
                        className="min-w-0 truncate rounded px-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-attachment-channel={row.channel}
                        onClick={(event) => {
                          event.stopPropagation()
                          navigate({ channel: row.channel, kind: row.channel.startsWith("dm-") ? "conversation" : "channel" })
                        }}
                        tabIndex={-1}
                        type="button"
                      >
                        {displayChannelLabel(row.channel)}
                      </button>
                      <time className="ml-auto shrink-0" dateTime={row.createdAt} title={absoluteTimeLabel(row.createdAt)}>{relativeAgeLabel(row.createdAt)}</time>
                    </div>
                    <AttachmentCard
                      actionTabIndex={-1}
                      attachment={row.attachment}
                      attachmentContentUrl={(id) => api.attachmentContentUrl(id)}
                      canPreview={canPreview}
                      fetchAttachmentContent={(id) => apiCall(api, fallbackApi, (client) => client.attachmentContent(id))}
                      showPath={false}
                    />
                    <div className="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                      {row.attachment.previewKind === "image" ? <ImageIcon aria-hidden="true" className="size-3.5" /> : row.attachment.previewKind === "markdown" ? <FileText aria-hidden="true" className="size-3.5" /> : <File aria-hidden="true" className="size-3.5" />}
                      <span className="shrink-0">{formatAttachmentSize(row.attachment.byteSize)}</span>
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

interface AttachmentMenuItem {
  action: () => void
  disabled?: boolean
  id: string
  label: string
}

function AttachmentRowMenu({ canView, onClose, onCopy, onGoToMessage, onView }: {
  canView: boolean
  onClose: () => void
  onCopy: () => void
  onGoToMessage: () => void
  onView: () => void
}) {
  const items = useMemo<AttachmentMenuItem[]>(() => [
    { action: onView, disabled: !canView, id: "view", label: "View" },
    { action: onGoToMessage, id: "message", label: "Go to message" },
    { action: onCopy, id: "copy", label: "Copy path" },
  ], [canView, onCopy, onGoToMessage, onView])
  const [activeIndex, setActiveIndex] = useState(canView ? 0 : 1)
  const menuRef = useRef<HTMLDivElement>(null)
  useKeyboardLayer({ mode: "modal", scope: "menu" }, undefined, onClose)

  useLayoutEffect(() => {
    const item = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
    item?.focus()
  }, [])

  useLayoutEffect(() => {
    const item = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[activeIndex]
    if (item !== undefined && !item.disabled) item.focus()
  }, [activeIndex])

  const nextEnabled = useCallback((index: number, direction: 1 | -1): number => {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const candidate = (index + direction * offset + items.length * 2) % items.length
      if (items[candidate]?.disabled !== true) return candidate
    }
    return index
  }, [items])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      event.stopPropagation()
      setActiveIndex((index) => nextEnabled(index, 1))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      event.stopPropagation()
      setActiveIndex((index) => nextEnabled(index, -1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      const item = items[activeIndex]
      if (item?.disabled !== true) item?.action()
    }
  }, [activeIndex, items, nextEnabled, onClose])

  return (
    <div
      aria-label="Attachment actions"
      className="absolute right-2 top-2 z-30 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      data-attachment-menu
      onKeyDownCapture={handleKeyDown}
      role="menu"
      ref={menuRef}
    >
      {items.map((item, index) => (
        <button
          className="flex w-full rounded px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-attachment-menu-item={item.id}
          disabled={item.disabled}
          key={item.id}
          onClick={item.action}
          onFocus={() => setActiveIndex(index)}
          role="menuitem"
          tabIndex={index === activeIndex ? 0 : -1}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function displayChannelLabel(channel: string): string {
  if (channel.startsWith("dm-")) return "Direct conversation"
  if (channel.startsWith("ws-")) return "Workspace broadcast"
  return `#${channel}`
}

function formatAttachmentSize(byteSize: number | null): string {
  if (byteSize === null) return "size unknown"
  if (byteSize < 1_000) return `${byteSize} B`
  if (byteSize < 1_000_000) return `${(byteSize / 1_000).toFixed(1)} KB`
  return `${(byteSize / 1_000_000).toFixed(1)} MB`
}
