import { useRef, type KeyboardEvent } from "react"

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

export interface CommandBrowserProps {
  entries: readonly CommandEntry[]
  home: readonly CommandEntry[]
  mode: "browse" | "recipients" | "actions"
  onChoose: (choice: CommandChoice) => void
  onActions: (entry: CommandEntry) => void
  position: CommandBrowserPosition
  onPosition: (position: CommandBrowserPosition) => void
}

export function CommandBrowser(props: CommandBrowserProps) {
  const { query, filter } = props.position
  const parsed = parseCommandQuery(query, filter)
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
}: CommandBrowserViewProps) {
  const browserRef = useRef<HTMLDivElement>(null)
  const active = position.active
  const setActive = (next: number) => onPosition({ ...position, active: next })
  const activeIndex = Math.max(0, Math.min(active, entries.length - 1))
  const selected = entries[activeIndex]
  function handleKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey) return
    const input = browserRef.current?.querySelector<HTMLInputElement>("input[role=combobox]")
    const inSearch = event.target === input
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        event.stopPropagation()
        setActive(entries.length === 0 ? 0 : (activeIndex + 1) % entries.length)
        input?.focus()
        break
      case "ArrowUp":
        event.preventDefault()
        event.stopPropagation()
        setActive(entries.length === 0 ? 0 : (activeIndex + entries.length - 1) % entries.length)
        input?.focus()
        break
      case "Enter":
        if (!inSearch) return
        event.preventDefault()
        event.stopPropagation()
        if (selected !== undefined) onChoose(selected)
        break
      case "ArrowRight":
        if (
          selected === undefined ||
          selected.alternatives.length === 0 ||
          !inSearch ||
          input?.selectionStart !== query.length ||
          input.selectionEnd !== query.length
        )
          return
        event.preventDefault()
        event.stopPropagation()
        onActions(selected)
        break
      default:
        if (!inSearch && event.key.length === 1 && event.key !== " ") {
          event.preventDefault()
          if (query.length < COMMAND_QUERY_LIMIT) onPosition({ ...position, active: 0, query: query + event.key })
          input?.focus()
        }
        break
    }
  }
  return (
    <div className="command-browser" onKeyDown={handleKey} ref={browserRef}>
      <CommandSearchInput
        activeId={selected === undefined ? undefined : commandOptionId(activeIndex)}
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
