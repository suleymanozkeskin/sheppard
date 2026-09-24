import { useEffect, useRef, type ReactNode } from "react"
import { browserCommandModifier } from "@/commands/keyboard"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  Command,
  CornerDownLeft,
  Focus,
  Hash,
  Inbox,
  Keyboard,
  MessageCircle,
  Monitor,
  Plus,
  Search,
  Settings2,
  SquareTerminal,
  StopCircle,
  SunMoon,
  UserCog,
  UserPlus,
  X,
  Paperclip,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { AgentAvatar } from "@/components/agent-avatar"
import { shellRoutePath } from "@/shell-routing"
import type { CommandChoice, CommandEntry, CommandFilter, CommandGlyph, CommandGroup } from "@/commands/types"
import { COMMAND_QUERY_LIMIT } from "@/commands/types"
import { commandOptionId } from "@/commands/browser-state"
import {
  COMMAND_BACK_HINT,
  COMMAND_LIST_BACK_HINT,
  COMMAND_CATEGORIES_HINT,
  COMMAND_CATEGORY_HELP,
} from "@/commands/navigation-keys"
import { COMMAND_CATEGORIES } from "@/commands/categories"

const GLYPHS = {
  agent: Bot,
  channel: Hash,
  message: MessageCircle,
  workspace: Monitor,
  spawn: UserPlus,
  search: Search,
  file: Paperclip,
  settings: Settings2,
  role: UserCog,
  terminal: SquareTerminal,
  focus: Focus,
  stop: StopCircle,
  connect: Plus,
  inbox: Inbox,
  theme: SunMoon,
  keyboard: Keyboard,
  plus: Plus,
} satisfies Record<CommandGlyph, typeof Bot>
const GROUP_NAMES = {
  context: "On this page",
  recent: "Recently opened",
  draft: "Your drafts",
  action: "Actions",
  agent: "Agents",
  chat: "Channels",
  direct: "Conversations",
  workspace: "Workspaces",
  page: "Explore",
} satisfies Record<CommandGroup, string>

export function CommandIcon({ glyph }: { glyph: CommandGlyph }) {
  const Icon = GLYPHS[glyph]
  return <Icon aria-hidden="true" className="size-[18px]" />
}

export function CommandBreadcrumb({
  path,
  leftBack,
  onBack,
}: {
  path: readonly string[]
  leftBack: boolean
  onBack: () => void
}) {
  return (
    <div className="command-breadcrumb">
      <Button
        aria-label="Back in command menu"
        data-command-back
        title={`Back to ${path.at(-2) ?? "Commands"}. Escape from any field; Left Arrow or Backspace from an empty search.`}
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ArrowLeft aria-hidden="true" />
        Back <kbd>{leftBack ? COMMAND_LIST_BACK_HINT : COMMAND_BACK_HINT}</kbd>
      </Button>
      <span aria-label="Command path" aria-live="polite" className="command-path" title={path.join(" › ")}>
        {path.slice(1).join(" › ")}
      </span>
    </div>
  )
}

export function CommandSearchInput({
  query,
  onChange,
  activeId,
  placeholder,
  categoryHelpId,
}: {
  query: string
  onChange: (value: string) => void
  activeId: string | undefined
  placeholder: string
  categoryHelpId: string | undefined
}) {
  return (
    <div className="command-search">
      <Search aria-hidden="true" className="size-5 shrink-0" />
      <input
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-controls="command-results"
        aria-describedby={categoryHelpId}
        aria-expanded="true"
        aria-label="Search commands and places"
        autoComplete="off"
        data-command-autofocus
        data-command-search
        id="channel-picker-input"
        maxLength={COMMAND_QUERY_LIMIT}
        name="command-search"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        role="combobox"
        spellCheck={false}
        value={query}
      />
      <span className="command-keycap">{browserCommandModifier()} K</span>
    </div>
  )
}

export function CommandFilters({
  filter,
  onChange,
  helpId,
  entry,
}: {
  filter: CommandFilter
  onChange: (filter: CommandFilter) => void
  helpId: string
  entry: "tab" | "tab-or-up"
}) {
  return (
    <div className="command-category-bar">
      <p className="sr-only" id={helpId}>
        {COMMAND_CATEGORY_HELP}
      </p>
      <div aria-label="Filter commands" aria-describedby={helpId} className="command-filters" role="toolbar">
        {COMMAND_CATEGORIES.map((item) => (
          <button
            aria-pressed={filter === item.value}
            aria-controls="command-results"
            data-command-category={item.value}
            key={item.value}
            tabIndex={filter === item.value ? 0 : -1}
            onClick={() => onChange(item.value)}
            type="button"
          >
            {item.label}
            {item.prefix.length > 0 && <span aria-hidden="true">{item.prefix}</span>}
          </button>
        ))}
      </div>
      <span aria-hidden="true" className="command-category-guide">
        <span className="command-category-enter">
          <kbd>{COMMAND_CATEGORIES_HINT}</kbd>
          {entry === "tab-or-up" && (
            <>
              <span>/</span>
              <kbd>↑</kbd>
            </>
          )}
          Categories
        </span>
        <span className="command-category-move">
          <kbd>←</kbd>
          <kbd>→</kbd> Switch <span>·</span> <kbd>↓</kbd>
          <kbd>↵</kbd> Results
        </span>
      </span>
    </div>
  )
}

function CommandOption({
  entry,
  active,
  index,
  onChoose,
  onActive,
}: {
  entry: CommandEntry
  active: boolean
  index: number
  onChoose: (choice: CommandChoice) => void
  onActive: (index: number) => void
}) {
  const ref = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" })
  }, [active])
  const props = {
    "aria-selected": active,
    "aria-disabled": entry.availability.kind === "unavailable",
    className: "command-option",
    "data-active": active,
    id: commandOptionId(index),
    onMouseMove: () => onActive(index),
    role: "option",
    tabIndex: -1,
  }
  const content = (
    <>
      <span className="command-option-icon" data-command-glyph={entry.glyph}>
        {entry.mark.kind === "harness" ? (
          <AgentAvatar agentKind={entry.mark.agentKind} />
        ) : (
          <CommandIcon glyph={entry.glyph} />
        )}
      </span>
      <span className="command-option-copy">
        <span>{entry.title}</span>
        <small>{entry.description}</small>
      </span>
      {entry.alternatives.length > 0 ? (
        <ArrowRight aria-hidden="true" className="command-option-arrow size-3.5" />
      ) : active ? (
        <CornerDownLeft aria-hidden="true" className="command-option-arrow size-3.5" />
      ) : null}
    </>
  )
  if (entry.action.kind === "navigate")
    return (
      <a
        {...props}
        href={shellRoutePath(entry.action.route)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          onChoose(entry)
        }}
        ref={(node) => {
          ref.current = node
        }}
      >
        {content}
      </a>
    )
  return (
    <button
      {...props}
      onClick={() => onChoose(entry)}
      ref={(node) => {
        ref.current = node
      }}
      type="button"
    >
      {content}
    </button>
  )
}

export function CommandResults({
  entries,
  activeIndex,
  onChoose,
  onActive,
  remaining,
}: {
  entries: readonly CommandEntry[]
  activeIndex: number
  onChoose: (choice: CommandChoice) => void
  onActive: (index: number) => void
  remaining: number
}) {
  return (
    <div className="command-results" id="command-results" role="listbox" aria-label="Commands and places">
      {entries.map((entry, index) => (
        <div data-picker-group={entry.group} key={entry.id}>
          {entries[index - 1]?.group !== entry.group && (
            <div className="command-group" role="presentation">
              {GROUP_NAMES[entry.group]}
            </div>
          )}
          <CommandOption
            active={index === activeIndex}
            entry={entry}
            index={index}
            onActive={onActive}
            onChoose={onChoose}
          />
        </div>
      ))}
      {entries.length === 0 && (
        <div className="command-empty">
          <Search aria-hidden="true" className="size-6" />
          <p>No matching items</p>
          <span>Try a name, workspace, role, or action.</span>
        </div>
      )}
      {remaining > 0 && (
        <p className="command-overflow">{remaining} more matches. Keep typing to narrow the results.</p>
      )}
    </div>
  )
}

export function CommandFooter({
  selected,
  onActions,
}: {
  selected: CommandEntry | undefined
  onActions: (entry: CommandEntry) => void
}) {
  return (
    <footer className="command-footer">
      <span className="command-brand">
        <Command aria-hidden="true" className="size-3.5" /> Sheppard
      </span>
      <span className="command-category-footer-hint">Type to search</span>
      <span className="command-hint">
        <kbd>
          <ArrowUp aria-label="Up" />
        </kbd>
        <kbd>
          <ArrowDown aria-label="Down" />
        </kbd>{" "}
        Select
      </span>
      <span className="command-hint">
        <kbd>
          <CornerDownLeft aria-label="Enter" />
        </kbd>{" "}
        {selected?.action.kind === "navigate" ? "Open" : "Choose"}
      </span>
      {selected !== undefined && selected.alternatives.length > 0 && (
        <button className="command-actions-button" onClick={() => onActions(selected)} type="button">
          Actions <kbd>→</kbd>
        </button>
      )}
    </footer>
  )
}

export function CommandNotice({
  message,
  children,
  onClose,
}: {
  message: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="command-notice" role="status">
      <Check aria-hidden="true" className="size-4 text-emerald-600 dark:text-emerald-400" />
      <span>{message}</span>
      {children}
      <Button aria-label="Dismiss command result" onClick={onClose} size="icon-xs" variant="ghost">
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}
