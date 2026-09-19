import { describe, expect, test } from "bun:test";

import { METADATA_SCOPES as HUB_METADATA_SCOPES } from "../src/types";
import { METADATA_SCOPES as WEB_METADATA_SCOPES } from "../web/src/api/types";

/**
 * The hub and the web client each carry their own copy of the scope list
 * because they build as separate projects. A scope present on one side only
 * breaks the strict stream decoder, so this test is the compile-time link.
 */
describe("metadata scope catalogue", () => {
  test("the hub and the web client publish the same scopes", () => {
    expect([...WEB_METADATA_SCOPES]).toEqual([...HUB_METADATA_SCOPES]);
  });
});
