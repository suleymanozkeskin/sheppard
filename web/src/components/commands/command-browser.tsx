import { useId, useLayoutEffect, useRef, type RefObject } from "react"

import { matchCommands, parseCommandQuery } from "@/commands/search"
import { recipientCatalog } from "@/commands/catalog"
import {
  commandChoice,
  commandEntry,
  COMMAND_QUERY_LIMIT,
  type CommandChoice,
  type CommandEntry,
  type CommandFilter,
} from "@/commands/types"
import { CommandFilters, CommandFooter, CommandResults, CommandSearchInput } from "./command-parts"
import { commandOptionId, type CommandBrowserPosition } from "@/commands/browser-state"
import type { CommandListIntent, CommandListKeyboard } from "@/commands/navigation-keys"
import { moveCommandCategory } from "@/commands/categories"

export interface CommandBrowserProps {
  entries: readonly CommandEntry[]
  home: readonly CommandEntry[]
  mode: "browse" | "recipients" | "actions"
  onChoose: (choice: CommandChoice) => void
  onActions: (entry: CommandEntry) => void
  position: CommandBrowserPosition
  onPosition: (position: CommandBrowserPosition) => void
  listKeyboard: RefObject<CommandListKeyboard | null>
}

export function CommandBrowser(props: CommandBrowserProps) {
  const { query, filter } = props.position
  const parsed = parseCommandQuery(query, filter, props.mode === "actions" ? "actions" : "commands")
  if (parsed.isErr())
    return (
      <p className="command-error" role="alert">
        {parsed.error.message}
      </p>
    )
  const recipients = props.mode === "recipients" || parsed.value.intent === "message"
  const source = recipients
    ? recipientCatalog(props.entries)
    : query.trim().length === 0 && filter === "all"
      ? props.home
      : props.entries
  const matches = matchCommands(source, parsed.value)
  const messageSearch =
    props.mode === "browse" && !recipients && parsed.value.text.length > 0
      ? [
          commandEntry(
            commandChoice(
              "action:search-query",
              `Search messages for “${parsed.value.text}”`,
              "Search conversation history across Sheppard",
              "search",
              { kind: "navigate", route: { kind: "search", query: parsed.value.text, scope: "all" } },
              "page",
            ),
          ),
        ]
      : []
  return (
    <CommandBrowserView
      {...props}
      entries={[...matches.entries, ...messageSearch]}
      filter={parsed.value.filter}
      filterQuery={parsed.value.intent === "message" ? `message ${parsed.value.text}` : parsed.value.text}
      query={query}
      remaining={matches.remaining}
    />
  )
}

interface CommandBrowserViewProps extends CommandBrowserProps {
  filter: CommandFilter
  filterQuery: string
  query: string
  remaining: number
}

function CommandBrowserView({
  entries,
  filter,
  filterQuery,
  mode,
  onActions,
  onChoose,
  onPosition,
  position,
  query,
  remaining,
  listKeyboard,
}: CommandBrowserViewProps) {
  const browserRef = useRef<HTMLDivElement>(null)
  const categoryHelpId = useId()
  const active = position.active
  const setActive = (next: number) => onPosition({ ...position, active: next })
  const activeIndex = Math.max(0, Math.min(active, entries.length - 1))
  const selected = entries[activeIndex]
  useCommandBrowserKeyboard({
    browserRef,
    listKeyboard,
    entries,
    activeIndex,
    selected,
    position,
    filter,
    filterQuery,
    onPosition,
    onChoose,
    onActions,
  })
  return (
    <div className="command-browser" ref={browserRef}>
      <CommandSearchInput
        activeId={selected === undefined ? undefined : commandOptionId(activeIndex)}
        categoryHelpId={mode === "actions" ? undefined : categoryHelpId}
        onChange={(value) => onPosition({ ...position, active: 0, query: value })}
        placeholder={
          mode === "recipients"
            ? "Find a person or channel…"
            : mode === "actions"
              ? "Find an action…"
              : "Find an agent, channel, or action…"
        }
        query={query}
      />
      {mode !== "actions" && (
        <CommandFilters
          filter={filter}
          helpId={categoryHelpId}
          entry={activeIndex === 0 ? "tab-or-up" : "tab"}
          onChange={(value) => onPosition({ query: filterQuery, active: 0, filter: value })}
        />
      )}
      <CommandResults
        activeIndex={activeIndex}
        entries={entries}
        onActive={setActive}
        onChoose={onChoose}
        remaining={remaining}
      />
      <CommandFooter onActions={onActions} selected={selected} />
    </div>
  )
}

interface CommandBrowserKeyboardProps extends Pick<
  CommandBrowserViewProps,
  "listKeyboard" | "entries" | "position" | "filter" | "filterQuery" | "onPosition" | "onChoose" | "onActions"
> {
  readonly browserRef: RefObject<HTMLDivElement | null>
  readonly activeIndex: number
  readonly selected: CommandEntry | undefined
}

/** Registers list navigation for the open menu. It changes local selection/focus, not API data. */
function useCommandBrowserKeyboard(props: CommandBrowserKeyboardProps) {
  const { listKeyboard } = props
  useLayoutEffect(() => {
    listKeyboard.current = (intent, key) => handleCommandBrowserKey(props, intent, key)
    return () => {
      listKeyboard.current = null
    }
  }, [listKeyboard, props])
}

/** Handles one list key. False leaves native behavior; true consumes the key. Choices use the host action handler. */
function handleCommandBrowserKey(props: CommandBrowserKeyboardProps, intent: CommandListIntent, key: string): boolean {
  const { browserRef, entries, activeIndex, selected, position, filter, filterQuery, onPosition, onChoose, onActions } =
    props
  const input = browserRef.current?.querySelector<HTMLInputElement>("[data-command-search]")
  switch (intent) {
    case "next-category":
    case "previous-category":
    case "first-category":
    case "last-category": {
      const next = moveCommandCategory(filter, intent)
      onPosition({ query: filterQuery, active: 0, filter: next })
      browserRef.current?.querySelector<HTMLButtonElement>(`[data-command-category="${next}"]`)?.focus()
      return true
    }
    case "results":
      input?.focus()
      return true
    case "next":
    case "previous": {
      const category = browserRef.current?.querySelector<HTMLButtonElement>(
        "[data-command-category][aria-pressed=true]",
      )
      if (intent === "previous" && activeIndex === 0 && category !== null && category !== undefined) {
        category.focus()
        return true
      }
      const step = intent === "next" ? 1 : entries.length - 1
      onPosition({ ...position, active: entries.length === 0 ? 0 : (activeIndex + step) % entries.length })
      input?.focus()
      return true
    }
    case "choose":
      if (selected !== undefined) onChoose(selected)
      return true
    case "actions":
      if (selected === undefined || selected.alternatives.length === 0) return false
      onActions(selected)
      return true
    case "type":
      if (position.query.length < COMMAND_QUERY_LIMIT)
        onPosition({ ...position, active: 0, query: position.query + key })
      input?.focus()
      return true
    default: {
      const unhandled: never = intent
      throw new Error(`Command browser has no handler for intent ${unhandled}`)
    }
  }
}
