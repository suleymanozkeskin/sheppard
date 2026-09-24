import { useLayoutEffect, useRef, type RefObject } from "react"

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
import type { CommandListKeyboard } from "@/commands/navigation-keys"

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
  const active = position.active
  const setActive = (next: number) => onPosition({ ...position, active: next })
  const activeIndex = Math.max(0, Math.min(active, entries.length - 1))
  const selected = entries[activeIndex]
  useLayoutEffect(() => {
    listKeyboard.current = (intent, key) => {
      const input = browserRef.current?.querySelector<HTMLInputElement>("[data-command-search]")
      switch (intent) {
        case "next":
        case "previous": {
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
          if (query.length < COMMAND_QUERY_LIMIT) onPosition({ ...position, active: 0, query: query + key })
          input?.focus()
          return true
      }
    }
    return () => {
      listKeyboard.current = null
    }
  }, [activeIndex, entries.length, listKeyboard, onActions, onChoose, onPosition, position, query, selected])
  return (
    <div className="command-browser" ref={browserRef}>
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
