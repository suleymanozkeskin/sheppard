/**
 * Human-facing output.
 *
 * Everything printed from stored data passes through `escapeForTerminal` first. A
 * message body is written by another agent, and an escape sequence reaching a
 * terminal can move the cursor, repaint the screen, or hide text that was
 * printed earlier. The server rejects terminal control characters on the way
 * in; escaping on the way out means a row written before that rule, or by any
 * other path, still cannot rewrite someone's screen. `--json` bypasses this
 * and gives the caller the raw data.
 */

import type {
  AttachmentMeta,
  ChannelReceipt,
  DirectConversation,
  InboxEntry,
  Member,
  Message,
  SearchResult,
} from "./types";
import type { Channel } from "./types";

/** Beyond this, a body is cut short so one message cannot flood a context. */
export const BODY_PREVIEW_LIMIT = 2_000;

const TAB = 0x09;
const NEWLINE = 0x0a;
const SPACE = 0x20;
const DELETE = 0x7f;
const C1_CONTROL_END = 0x9f;

/**
 * Keeps tab and newline, which carry layout, and renders every other control
 * character as visible text so it cannot act on the terminal. Carriage return is
 * escaped too: on its own it returns the cursor and overwrites the line.
 */
export function escapeForTerminal(text: string): string {
  let escaped = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === TAB || code === NEWLINE) {
      escaped += character;
      continue;
    }
    if (code < SPACE || (code >= DELETE && code <= C1_CONTROL_END)) {
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    escaped += character;
  }
  return escaped;
}

function truncate(body: string, channel: string, full: boolean): string {
  if (full || body.length <= BODY_PREVIEW_LIMIT) return body;
  return `${body.slice(0, BODY_PREVIEW_LIMIT)}\n[truncated — msgr history ${channel} 1 --full]`;
}

function humanBytes(size: number | null): string {
  if (size === null) return "size unknown";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentLine(attachment: AttachmentMeta): string {
  const facts = [humanBytes(attachment.byteSize)];
  if (attachment.mediaType !== null) facts.unshift(attachment.mediaType);
  if (attachment.previewEligible) facts.push("previewable");
  return `  attached: ${escapeForTerminal(attachment.path)}  (${facts.join(", ")})`;
}

/** `sender (kind)` when the harness is known, so a reply can be aimed correctly. */
function attribution(message: Message): string {
  const sender = escapeForTerminal(message.sender);
  const agentKind = message.senderAgentKind === null ? null : escapeForTerminal(message.senderAgentKind);
  return agentKind === null ? sender : `${sender} (${agentKind})`;
}

export function renderMessage(message: Message, full: boolean): string[] {
  const lines = [
    `[${message.id}] ${attribution(message)}  ${message.createdAt}`,
    escapeForTerminal(truncate(message.body, message.channel, full)),
  ];
  for (const attachment of message.attachments) lines.push(attachmentLine(attachment));
  return lines;
}

export function renderMessages(header: string, messages: readonly Message[], full: boolean): string[] {
  if (messages.length === 0) return [header];

  const lines = [header];
  for (const message of messages) {
    lines.push("");
    lines.push(...renderMessage(message, full));
  }
  return lines;
}

export function renderInbox(entries: readonly InboxEntry[]): string[] {
  if (entries.length === 0) {
    return ["No channels joined. Run: msgr join <channel>"];
  }

  const lines: string[] = [];
  let unread = 0;
  for (const entry of entries) {
    unread += entry.unread;
    const channel = `#${escapeForTerminal(entry.channel)}`;
    lines.push(
      entry.unread === 0
        ? `${channel}: nothing new`
        : `${channel}: ${entry.unread} unread from ${entry.senders.map(escapeForTerminal).join(", ")}`,
    );
  }

  const first = entries[0];
  if (first !== undefined) {
    const delivery = first.pushEnabled ? "push on" : "poll only";
    lines.push("");
    lines.push(`route ${first.routeState}, ${delivery}`);
  }
  if (unread > 0) {
    lines.push(`Run: msgr read --all`);
  }
  return lines;
}

export function renderChannels(channels: readonly Channel[]): string[] {
  if (channels.length === 0) return ["No channels yet. Run: msgr channels create <name>"];

  return channels.map((channel) => {
    const parts = [
      `#${escapeForTerminal(channel.name)}`,
      `${channel.memberCount} members`,
      `${channel.messageCount} messages`,
    ];
    if (channel.topic !== null) parts.push(escapeForTerminal(channel.topic));
    return parts.join("  ");
  });
}

export function renderDirectConversations(conversations: readonly DirectConversation[]): string[] {
  if (conversations.length === 0) return ["No direct conversations yet. Run: msgr dm <handle> <text>"];

  return conversations.map((conversation) => {
    const participants = conversation.participants.map(escapeForTerminal).join(", ");
    return `#${escapeForTerminal(conversation.channel)}  with ${participants}  ${conversation.unread} unread`;
  });
}

export function renderMembers(members: readonly Member[]): string[] {
  if (members.length === 0) return ["No members yet."];

  return members.map((member) => {
    const agentKind = member.agentKind === null ? null : escapeForTerminal(member.agentKind);
    const kind = agentKind === null ? member.kind : `${member.kind} (${agentKind})`;
    const route = member.kind === "human" ? "—" : member.routeState;
    return `${escapeForTerminal(member.handle)}  ${kind}  route ${route}  ${member.unread} unread`;
  });
}

export function renderReceipts(receipts: readonly ChannelReceipt[]): string[] {
  if (receipts.length === 0) return ["No members yet."];

  return receipts.map((receipt) =>
    `${escapeForTerminal(receipt.handle)}  cursor ${receipt.cursorMessageId}  route ${receipt.routeState}`,
  );
}

export function renderSearch(results: readonly SearchResult[]): string[] {
  if (results.length === 0) return ["No matches."];

  const lines: string[] = [];
  for (const result of results) {
    lines.push(
      `#${escapeForTerminal(result.channel)} [${result.messageId}] ${escapeForTerminal(result.sender)}  ${result.createdAt}`,
    );
    lines.push(`  ${escapeForTerminal(result.snippet)}`);
  }
  return lines;
}
