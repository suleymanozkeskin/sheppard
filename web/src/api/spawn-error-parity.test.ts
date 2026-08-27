import { describe, expect, it } from "bun:test"

import { operatorMessage, type FailureCopyInput } from "../../../src/error-copy"
import { ApiHttpError, formatApiError } from "./errors"

interface SpawnCopyCase {
  name: string
  detail: string
  title: string
  action: string
}

const spawnCopyCases: readonly SpawnCopyCase[] = [
  {
    name: "timeout with pane",
    detail: "herdr agent start did not complete: timed out while starting pane w1:spawned-2",
    title: "herdr did not answer in time while starting the agent.",
    action: "Pane w1:spawned-2 was opened first. If no agent appears in it, close it. Do not retry until the pane is resolved.",
  },
  {
    name: "unreachable with pane",
    detail: "herdr agent start did not complete: agent start failed while starting pane w1:spawned-2",
    title: "herdr could not confirm the spawn.",
    action: "Pane w1:spawned-2 was opened first. Inspect it and close it if no agent appears.",
  },
  {
    name: "reported rollback closed",
    detail: "agent start failed",
    title: "The spawn failed.",
    action: "Nothing was created. The pane from the partial spawn was closed.",
  },
  {
    name: "cleanup failed",
    detail: "spawn cleanup pane close failed while cleaning up pane w1:spawned-2; cleanup state is unresolved",
    title: "The spawn failed and cleanup is unresolved.",
    action: "Pane w1:spawned-2 may still be open. Check it before you retry.",
  },
  {
    name: "no-ID timeout unresolved",
    detail: "pane split timed out; pane identity is unknown; cleanup state is unresolved",
    title: "The spawn failed and cleanup is unresolved.",
    action: "The pane state is unknown. Check for a leftover pane before you retry.",
  },
]

function rootFailure(detail: string): FailureCopyInput {
  return {
    operation: "spawnAgent",
    cause: "HerdrCallFailed",
    detail,
    value: undefined,
  }
}

function browserFailure(detail: string): ApiHttpError {
  return new ApiHttpError({
    body: JSON.stringify({ code: "HerdrCallFailed", error: detail }),
    message: "spawn failed",
    operation: "spawnAgent",
    status: 503,
  })
}

describe("spawn error copy parity", () => {
  for (const failure of spawnCopyCases) {
    it(`${failure.name} matches the root copy`, () => {
      const root = operatorMessage(rootFailure(failure.detail), "browser")
      expect(root).toEqual({ title: failure.title, action: failure.action })

      expect(formatApiError(browserFailure(failure.detail))).toBe(
        `${failure.title} ${failure.action}`,
      )
    })
  }
})
