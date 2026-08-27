import { describe, expect, test } from "bun:test";
import {
  BODY_PREVIEW_LIMIT,
  escapeForTerminal,
  renderMembers,
  renderMessage,
  renderSearch,
} from "../src/format";
import type { Member, Message, SearchResult } from "../src/types";

const ESCAPE = "\u001b";
const BELL = "\u0007";
const CARRIAGE_RETURN = "\r";
const BACKSPACE = "\u0008";
const DEL = "\u007f";
const NEXT_LINE = "\u0085";
const NUL = "\u0000";
const VERTICAL_TAB = "\u000b";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    channel: "backend",
    sender: "alice",
    senderKind: "agent",
    senderAgentKind: null,
    body: "hello",
    attachments: [],
    createdAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  };
}

describe("terminal escaping", () => {
  test("renders an escape sequence as text so it cannot act", () => {
    const coloured = `${ESCAPE}[31mred${ESCAPE}[0m`;
    const escaped = escapeForTerminal(coloured);
    expect(escaped).not.toContain(ESCAPE);
    expect(escaped).toBe("\\x1b[31mred\\x1b[0m");
  });

  test("neutralises the sequences that rewrite a screen", () => {
    for (const character of [BELL, CARRIAGE_RETURN, BACKSPACE, DEL, NEXT_LINE, NUL, VERTICAL_TAB]) {
      const escaped = escapeForTerminal(`before${character}after`);
      expect(escaped).not.toContain(character);
      expect(escaped).toContain("before");
      expect(escaped).toContain("after");
    }
  });

  test("keeps the whitespace that carries layout", () => {
    expect(escapeForTerminal("one\ntwo\tthree")).toBe("one\ntwo\tthree");
  });

  test("leaves ordinary text, punctuation, and other scripts alone", () => {
    const text = "Deploy #42 — düşük öncelik, 90% done: `code`";
    expect(escapeForTerminal(text)).toBe(text);
  });

  test("does not mangle emoji or characters outside the basic plane", () => {
    expect(escapeForTerminal("shipped 🚀 today")).toBe("shipped 🚀 today");
  });
});

describe("message rendering", () => {
  test("escapes a body written by someone else", () => {
    const hostile = message({ body: `${ESCAPE}[2Jcleared your screen` });
    const rendered = renderMessage(hostile, true).join("\n");
    expect(rendered).not.toContain(ESCAPE);
    expect(rendered).toContain("cleared your screen");
  });

  test("escapes an attachment path", () => {
    const rendered = renderMessage(
      message({
        attachments: [
          {
            id: 1,
            path: `/tmp/${ESCAPE}[31mred/chart.png`,
            displayName: "chart.png",
            byteSize: 2048,
            mediaType: "image/png",
            previewEligible: true,
            previewKind: "image",
          },
        ],
      }),
      true,
    ).join("\n");

    expect(rendered).not.toContain(ESCAPE);
    expect(rendered).toContain("2 KB");
    expect(rendered).toContain("previewable");
  });

  test("names the harness only when it is known", () => {
    expect(renderMessage(message({ senderAgentKind: "codex" }), true)[0]).toContain("alice (codex)");
    const hostile = renderMessage(message({ senderAgentKind: `${ESCAPE}[31m` }), true).join("\n");
    expect(hostile).not.toContain(ESCAPE);
    expect(renderMessage(message({ senderAgentKind: null }), true)[0]).toContain("alice");
    expect(renderMessage(message({ senderAgentKind: null }), true)[0]).not.toContain("(");
  });

  test("escapes the harness in member output", () => {
    const rendered = renderMembers([
      {
        handle: "alice",
        kind: "agent",
        agentKind: `${ESCAPE}[31m`,
        routeState: "active",
        unread: 0,
        joinedAt: "2026-08-17T12:00:00.000Z",
      },
    ]);
    expect(rendered.join("\n")).not.toContain(ESCAPE);
  });

  test("truncates a long body and points at the full copy", () => {
    const long = message({ body: "z".repeat(BODY_PREVIEW_LIMIT + 500) });
    const rendered = renderMessage(long, false).join("\n");

    expect(rendered).toContain("[truncated — msgr history backend 1 --full]");
    expect(rendered.length).toBeLessThan(BODY_PREVIEW_LIMIT + 200);
  });

  test("leaves a body at the limit whole", () => {
    const exact = message({ body: "z".repeat(BODY_PREVIEW_LIMIT) });
    expect(renderMessage(exact, false).join("\n")).not.toContain("[truncated");
  });

  test("keeps the whole body when asked for it", () => {
    const long = message({ body: "z".repeat(BODY_PREVIEW_LIMIT + 500) });
    const rendered = renderMessage(long, true).join("\n");

    expect(rendered).not.toContain("[truncated");
    expect(rendered).toContain("z".repeat(BODY_PREVIEW_LIMIT + 500));
  });

  test("reports a size that is not known rather than inventing one", () => {
    const rendered = renderMessage(
      message({
        attachments: [
          {
            id: 1,
            path: "/tmp/thing",
            displayName: "thing",
            byteSize: null,
            mediaType: null,
            previewEligible: false,
            previewKind: null,
          },
        ],
      }),
      true,
    ).join("\n");
    expect(rendered).toContain("size unknown");
  });
});

describe("listing rendering", () => {
  function member(overrides: Partial<Member> = {}): Member {
    return {
      handle: "alice",
      kind: "agent",
      agentKind: null,
      routeState: "active",
      unread: 0,
      joinedAt: "2026-08-17T12:00:00.000Z",
      ...overrides,
    };
  }

  test("shows a human with no route rather than a state that cannot apply", () => {
    const rendered = renderMembers([member({ handle: "suleyman", kind: "human" })]).join("\n");
    expect(rendered).toContain("route —");
  });

  test("shows an agent's harness and route state", () => {
    const rendered = renderMembers([
      member({ agentKind: "claude", routeState: "stale", unread: 3 }),
    ]).join("\n");
    expect(rendered).toContain("agent (claude)");
    expect(rendered).toContain("route stale");
    expect(rendered).toContain("3 unread");
  });

  test("escapes a snippet coming back from search", () => {
    const results: SearchResult[] = [
      {
        messageId: 7,
        channel: "backend",
        sender: "alice",
        snippet: `${ESCAPE}[2Jhidden`,
        createdAt: "2026-08-17T12:00:00.000Z",
      },
    ];
    const rendered = renderSearch(results).join("\n");
    expect(rendered).not.toContain(ESCAPE);
    expect(rendered).toContain("hidden");
  });
});
