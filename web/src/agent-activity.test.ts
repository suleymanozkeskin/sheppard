import { expect, test } from "bun:test"
import { HttpMsgrApi } from "@/api/client"
import { mockMessages } from "@/api/fixtures"
import { readAgentActivity } from "./agent-activity"

test("older activity references use their exact message context", async () => {
  const message = mockMessages[0]
  if (message === undefined) throw new Error("The activity test requires one message fixture")
  const reads: string[] = []
  const api = new HttpMsgrApi({
    baseUrl: "",
    fetchImpl: async (input) => {
      const path = String(input)
      reads.push(path)
      return Response.json({ messages: path.includes("/context") ? [message] : [] })
    },
  })
  const result = await readAgentActivity(api, [{ channel: message.channel, messageIds: [message.id] }])
  expect(result.isOk()).toBe(true)
  if (result.isOk()) expect(result.value).toEqual([message])
  expect(reads).toHaveLength(2)
  expect(reads[1]).toContain(`around=${message.id}`)
})

test("a deleted activity reference is an error, not no activity", async () => {
  const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async () => Response.json({ messages: [] }) })
  const result = await readAgentActivity(api, [{ channel: "review", messageIds: [1] }])
  expect(result.isErr()).toBe(true)
  if (result.isErr()) expect(result.error.message).toContain("Message 1 in review")
})

test("empty activity makes no read and failed reads remain failures", async () => {
  let reads = 0
  const api = new HttpMsgrApi({
    baseUrl: "",
    fetchImpl: async () => {
      reads += 1
      throw new TypeError("Offline")
    },
  })
  const empty = await readAgentActivity(api, [])
  expect(empty.isOk()).toBe(true)
  if (empty.isOk()) expect(empty.value).toEqual([])
  expect(reads).toBe(0)
  expect((await readAgentActivity(api, [{ channel: "review", messageIds: [1] }])).isErr()).toBe(true)
  expect(reads).toBe(1)
})
