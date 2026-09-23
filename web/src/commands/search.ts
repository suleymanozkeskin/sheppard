import { Result, TaggedError } from "better-result"

import { COMMAND_QUERY_LIMIT, COMMAND_RESULT_LIMIT, type CommandEntry, type CommandFilter } from "./types"

export class CommandQueryTooLong extends TaggedError("CommandQueryTooLong")<{
  readonly message: string
}> {}

export interface CommandQuery {
  readonly text: string
  readonly filter: CommandFilter
  readonly intent: "open" | "message"
  readonly tokens: readonly string[]
}

/** Parses user input once. Invalid input has no effects; shorten it to retry. */
export function parseCommandQuery(input: string, filter: CommandFilter): Result<CommandQuery, CommandQueryTooLong> {
  if (input.length > COMMAND_QUERY_LIMIT) return Result.err(new CommandQueryTooLong({ message: `Search is limited to ${COMMAND_QUERY_LIMIT} characters. Shorten your search.` }))
  const normalized = input.trim().toLocaleLowerCase()
  const message = /^(?:message|msg|send to)(?:\s+|$)/u.exec(normalized)
  const intent = message === null ? "open" : "message"
  const body = message === null ? normalized : normalized.slice(message[0].length).trim()
  const prefix = body[0]
  const selectedFilter = prefix === "@" ? "agent" : prefix === "#" ? "chat" : prefix === ">" ? "action" : filter
  const text = prefix === "@" || prefix === "#" || prefix === ">" ? body.slice(1).trim() : body
  return Result.ok(Object.freeze({ text, filter: selectedFilter, intent, tokens: Object.freeze(text.split(/\s+/u).filter(Boolean)) }))
}

type MatchRank = Readonly<{ kind: "match"; rank: number }> | Readonly<{ kind: "miss" }>

function rankEntry(entry: CommandEntry, query: CommandQuery): MatchRank {
  const title = entry.title.toLocaleLowerCase().replace(/^[@#]/u, "")
  const searchable = `${title} ${entry.description} ${entry.keywords}`.toLocaleLowerCase()
  if (!query.tokens.every((token) => searchable.includes(token))) return { kind: "miss" }
  if (title === query.text) return { kind: "match", rank: 0 }
  if (title.startsWith(query.text)) return { kind: "match", rank: 1 }
  if (query.tokens.every((token) => title.includes(token))) return { kind: "match", rank: 2 }
  return { kind: "match", rank: 3 }
}

function matchesFilter(entry: CommandEntry, filter: CommandFilter): boolean {
  switch (filter) {
    case "all": return true
    case "agent": return entry.group === "agent"
    case "chat": return entry.group === "chat"
    case "workspace": return entry.group === "workspace"
    case "action": return entry.group === "action" || entry.group === "page" || entry.group === "context"
  }
}

export interface CommandMatches {
  readonly entries: readonly CommandEntry[]
  readonly total: number
  readonly remaining: number
}

/** Ranks exact names before supporting text. Equal ranks retain source order.
 * Results are a bounded view; remaining reports entries that require refinement.
 */
export function matchCommands(entries: readonly CommandEntry[], query: CommandQuery): CommandMatches {
  const ranked = entries.flatMap((entry, index) => {
    if (!matchesFilter(entry, query.filter)) return []
    const match = rankEntry(entry, query)
    return match.kind === "miss" ? [] : [{ entry, rank: match.rank, index }]
  }).toSorted((left, right) => left.rank - right.rank || left.index - right.index)
  return Object.freeze({
    entries: Object.freeze(ranked.slice(0, COMMAND_RESULT_LIMIT).map(({ entry }) => entry)),
    total: ranked.length,
    remaining: Math.max(0, ranked.length - COMMAND_RESULT_LIMIT),
  })
}

/** Single-recipient commands never reuse a group conversation. */
export type AgentConversation = Readonly<{ kind: "existing"; channel: string }> | Readonly<{ kind: "not-started" }>

export function directChannelForAgent(conversations: readonly { readonly channel: string; readonly participants: readonly string[] }[], handle: string): AgentConversation {
  const conversation = conversations.find((candidate) => candidate.participants.length === 1 && candidate.participants[0] === handle)
  return Object.freeze(conversation === undefined ? { kind: "not-started" } : { kind: "existing", channel: conversation.channel })
}
