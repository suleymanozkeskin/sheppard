import { Hash, LoaderCircle, MessageCircle, MoreHorizontal, Paperclip, Search, SearchX } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react"

import type { SearchResult } from "@/api/types"
import { Marker, MarkerContent } from "@/components/ui/marker"
import { Button } from "@/components/ui/button"
import { useKeyboardLayer } from "@/hooks/use-keyboard-dispatcher"
import { isModifierCombo, type KeyEventLike } from "@/keyboard"
import { absoluteTimeLabel, relativeAgeLabel } from "@/workspace-presentation"

export type SearchLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string }

type SearchViewScope = "all" | "channel"

export interface SearchViewProps {
  channelLabel?: (channel: string) => string
  query: string
  results: SearchResult[]
  scope: SearchViewScope
  state: SearchLoadState
  truncated: boolean
  notice?: string
  selectedResultId?: number
  queryInputRef: RefObject<HTMLInputElement | null>
  onClose: () => void
  onQueryChange: (query: string) => void
  onScopeChange: (scope: SearchViewScope) => void
  onShowAttachments: (result: SearchResult) => void
  onSelect: (result: SearchResult) => void
  onSubmit: () => void
  onRetry: () => void
}

export function SearchView({
  channelLabel,
  query,
  results,
  scope,
  state,
  truncated,
  notice,
  selectedResultId,
  queryInputRef,
  onClose,
  onQueryChange,
  onScopeChange,
  onShowAttachments,
  onSelect,
  onSubmit,
  onRetry,
}: SearchViewProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const activeIndexRef = useRef(0)
  const focusActiveResultRef = useRef(false)
  const resultRefs = useRef(new Map<number, HTMLButtonElement>())
  const pendingMenuFocusRef = useRef<number | undefined>(undefined)
  const [menuResultId, setMenuResultId] = useState<number | undefined>()
  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => queryInputRef.current?.focus())
    return () => globalThis.cancelAnimationFrame(frame)
  }, [queryInputRef])
  useEffect(() => {
    const selectedIndex = selectedResultId === undefined
      ? -1
      : results.findIndex((result) => result.messageId === selectedResultId)
    const nextIndex = selectedIndex >= 0 ? selectedIndex : Math.min(activeIndexRef.current, Math.max(results.length - 1, 0))
    if (nextIndex === activeIndexRef.current) return
    activeIndexRef.current = nextIndex
    setActiveIndex(nextIndex)
  }, [results, selectedResultId])
  useEffect(() => {
    if (!focusActiveResultRef.current || state.status !== "ready") return
    const result = results[activeIndex]
    if (result === undefined) return
    focusActiveResultRef.current = false
    const frame = globalThis.requestAnimationFrame(() => resultRefs.current.get(result.messageId)?.focus())
    return () => globalThis.cancelAnimationFrame(frame)
  }, [activeIndex, results, state.status])
  useEffect(() => {
    if (menuResultId === undefined || results.some((result) => result.messageId === menuResultId)) return
    pendingMenuFocusRef.current = menuResultId
    setMenuResultId(undefined)
  }, [menuResultId, results])
  useLayoutEffect(() => {
    if (menuResultId !== undefined) return
    const resultId = pendingMenuFocusRef.current
    if (resultId === undefined) return
    pendingMenuFocusRef.current = undefined
    resultRefs.current.get(resultId)?.focus()
  }, [menuResultId])
  const moveActive = useCallback((delta: number) => {
    if (results.length === 0) return
    const next = (activeIndex + delta + results.length) % results.length
    focusActiveResultRef.current = true
    activeIndexRef.current = next
    setActiveIndex(next)
  }, [activeIndex, results.length])
  const closeResultMenu = useCallback(() => {
    if (menuResultId === undefined) return
    pendingMenuFocusRef.current = menuResultId
    setMenuResultId(undefined)
  }, [menuResultId])
  const toggleResultMenu = useCallback((result: SearchResult) => {
    if (result.attachmentCount <= 0) return
    if (menuResultId === result.messageId) {
      closeResultMenu()
      return
    }
    setMenuResultId(result.messageId)
  }, [closeResultMenu, menuResultId])
  const handleLayerKeyDown = useCallback((event: KeyEventLike): boolean => {
    const activeElement = globalThis.document.activeElement
    const typing = activeElement instanceof HTMLInputElement
      || activeElement instanceof HTMLSelectElement
      || activeElement instanceof HTMLTextAreaElement
    if (typing) return false
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
      const result = results[activeIndex]
      if (result === undefined || result.attachmentCount <= 0) return true
      setMenuResultId(result.messageId)
      return true
    }
    if (event.key === "Enter") {
      const result = results[activeIndex]
      if (result !== undefined) onSelect(result)
      return result !== undefined
    }
    return false
  }, [activeIndex, moveActive, onSelect, results])
  useKeyboardLayer({ mode: "inline", scope: "search" }, handleLayerKeyDown, onClose)
  const activeResultId = results[activeIndex]?.messageId ?? selectedResultId
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="border-b px-4 py-3 sm:px-8">
        <form className="flex min-w-0 flex-col gap-2 sm:flex-row" onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}>
          <label className="sr-only" htmlFor="search-page-query">Search messages</label>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-muted-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <input
              aria-label="Search messages"
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              id="search-page-query"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search messages"
              ref={queryInputRef}
              type="search"
              value={query}
            />
          </div>
          <div aria-label="Search scope" className="grid grid-cols-2 rounded-lg border bg-muted/40 p-1 sm:w-auto sm:shrink-0" role="group">
            <button aria-pressed={scope === "all"} className="min-h-9 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onScopeChange("all")} type="button">All channels</button>
            <button aria-pressed={scope === "channel"} className="min-h-9 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onScopeChange("channel")} type="button">Current channel</button>
          </div>
          <Button type="submit">
            <Search aria-hidden="true" />
            Search
          </Button>
        </form>
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-search-count={results.length}
          data-search-truncated={truncated ? "true" : undefined}
          role="status"
        >
          {results.length} matches shown{truncated && " · more may exist — refine the query"}
        </p>
        {notice !== undefined && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-search-cap-notice role="status">{notice}</p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {state.status === "loading" && (
          <Marker className="mx-auto max-w-md" variant="separator">
            <MarkerContent className="inline-flex items-center gap-2 px-3 text-center">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Searching messages…
            </MarkerContent>
          </Marker>
        )}
        {state.status === "error" && (
          <Marker className="mx-auto max-w-md text-destructive" variant="separator">
            <MarkerContent className="inline-flex flex-wrap items-center justify-center gap-2 px-3 text-center">
              {state.message}
              <button className="rounded border px-2 py-1 text-xs text-foreground hover:bg-muted" onClick={onRetry} type="button">Try again</button>
            </MarkerContent>
          </Marker>
        )}
        {state.status === "ready" && results.length === 0 && (
          <Marker className="mx-auto max-w-md" variant="separator">
            <MarkerContent className="inline-flex items-center gap-2 px-3 text-center">
              <SearchX aria-hidden="true" className="size-4" />
              No messages matched this search.
            </MarkerContent>
          </Marker>
        )}
        {state.status === "ready" && results.length > 0 && (
          <ol aria-label="Search results" className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
            {results.map((result, index) => (
              <li key={`${result.channel}:${result.messageId}`}>
                <div className="group relative overflow-visible rounded-xl" data-search-result-row={result.messageId}>
                  <button
                    aria-current={activeResultId === result.messageId ? "true" : undefined}
                    className="w-full min-w-0 rounded-xl border bg-card p-4 pr-14 text-left transition-colors hover:bg-muted aria-[current=true]:border-ring aria-[current=true]:ring-2 aria-[current=true]:ring-ring/20"
                    data-search-result={result.messageId}
                    onClick={() => onSelect(result)}
                    onFocus={() => {
                      activeIndexRef.current = index
                      setActiveIndex(index)
                    }}
                    ref={(element) => {
                      if (element === null) resultRefs.current.delete(result.messageId)
                      else resultRefs.current.set(result.messageId, element)
                    }}
                    tabIndex={activeResultId === result.messageId ? 0 : -1}
                    type="button"
                  >
                    <span className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground">
                      <SearchChannelIcon channel={result.channel} />
                      <span className="min-w-0 truncate font-medium text-foreground">{channelLabel?.(result.channel) ?? displayStorageChannelLabel(result.channel)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="min-w-0 truncate">{result.sender}</span>
                      {result.attachmentCount > 0 && (
                        <span
                          aria-label={`${result.attachmentCount} attachment${result.attachmentCount === 1 ? "" : "s"}`}
                          className="inline-flex shrink-0 items-center gap-1"
                          data-search-attachment-count={result.attachmentCount}
                          role="img"
                        >
                          <Paperclip aria-hidden="true" className="size-3.5" />
                          <span aria-hidden="true">{result.attachmentCount}</span>
                        </span>
                      )}
                      <time className="ml-auto shrink-0" dateTime={result.createdAt} title={absoluteTimeLabel(result.createdAt)}>
                        {relativeAgeLabel(result.createdAt)}
                      </time>
                    </span>
                    <span className="mt-2 block min-w-0 max-w-full overflow-hidden break-words text-sm leading-relaxed text-foreground">
                      {highlightSnippet(result.snippet, query)}
                    </span>
                  </button>
                  {result.attachmentCount > 0 && (
                    <Button
                      aria-expanded={menuResultId === result.messageId}
                      aria-haspopup="menu"
                      aria-label={`More actions for message ${result.messageId}`}
                      className="absolute right-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                      data-search-menu-trigger={result.messageId}
                      onClick={(event) => {
                        event.stopPropagation()
                        activeIndexRef.current = index
                        setActiveIndex(index)
                        toggleResultMenu(result)
                      }}
                      onFocus={() => {
                        activeIndexRef.current = index
                        setActiveIndex(index)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        event.stopPropagation()
                        toggleResultMenu(result)
                      }}
                      size="icon-sm"
                      title="Search result actions"
                      type="button"
                      variant="ghost"
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  )}
                  {menuResultId === result.messageId && (
                    <SearchResultMenu
                      onClose={closeResultMenu}
                      onShowAttachments={() => {
                        closeResultMenu()
                        onShowAttachments(result)
                      }}
                    />
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function SearchResultMenu({ onClose, onShowAttachments }: {
  onClose: () => void
  onShowAttachments: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  useKeyboardLayer({ mode: "modal", scope: "menu" }, undefined, onClose)

  useLayoutEffect(() => {
    itemRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      event.stopPropagation()
      itemRef.current?.focus()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      onShowAttachments()
    }
  }, [onClose, onShowAttachments])

  return (
    <div
      aria-label="Search result actions"
      className="absolute right-2 top-12 z-30 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      data-search-menu
      onKeyDownCapture={handleKeyDown}
      ref={menuRef}
      role="menu"
    >
      <button
        className="flex min-h-9 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
        data-search-menu-item="show-in-attachments"
        onClick={onShowAttachments}
        ref={itemRef}
        role="menuitem"
        tabIndex={0}
        type="button"
      >
        Show in attachments
      </button>
    </div>
  )
}

function SearchChannelIcon({ channel }: { channel: string }) {
  return channel.startsWith("dm-")
    ? <MessageCircle aria-hidden="true" className="size-3.5 shrink-0" />
    : <Hash aria-hidden="true" className="size-3.5 shrink-0" />
}

function displayStorageChannelLabel(channel: string): string {
  if (channel.startsWith("dm-")) return "Direct conversation"
  if (channel.startsWith("ws-")) return "Workspace broadcast"
  return `#${channel}`
}

function highlightSnippet(snippet: string, query: string): ReactNode {
  const terms = [...new Set(query.split(/\s+/u).map((term) => term.trim()).filter((term) => term.length > 0))]
  if (terms.length === 0) return snippet
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  const matcher = new RegExp(`(${escaped.join("|")})`, "giu")
  const termSet = new Set(terms.map((term) => term.toLocaleLowerCase()))
  return snippet.split(matcher).map((part, index) =>
    termSet.has(part.toLocaleLowerCase()) ? <mark className="rounded bg-primary/20 px-0.5" key={`${part}-${index}`}>{part}</mark> : part,
  )
}
