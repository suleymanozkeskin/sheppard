import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeObject, optionalStringArray, requiredInteger, requiredString } from "../src/json";
import { literalQuery } from "../src/search";
import { testHub } from "./http-support";
import { expectErr, expectOk } from "./support";

function builtWebRoot() {
  const root = mkdtempSync(join(tmpdir(), "msgr-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<div id=root></div>");
  writeFileSync(join(root, "assets", "main-a1b2c3.js"), "console.log(1)");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("static serving", () => {
  test("reports plainly when the interface has not been built", async () => {
    const hub = testHub({ webRoot: "/nonexistent-web-root" });
    const response = await hub.get("/");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("serves the entry document without caching it", async () => {
    const web = builtWebRoot();
    try {
      const hub = testHub({ webRoot: web.root });
      const response = await hub.get("/");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toContain("id=root");
    } finally {
      web.cleanup();
    }
  });

  test("caches hashed assets indefinitely", async () => {
    const web = builtWebRoot();
    try {
      const hub = testHub({ webRoot: web.root });
      const response = await hub.get("/assets/main-a1b2c3.js");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    } finally {
      web.cleanup();
    }
  });

  test("falls back to the entry document for client routes", async () => {
    const web = builtWebRoot();
    try {
      const hub = testHub({ webRoot: web.root });
      const response = await hub.get("/channels/backend");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("id=root");
    } finally {
      web.cleanup();
    }
  });

  test("never lets the fallback answer for an api path", async () => {
    const web = builtWebRoot();
    try {
      const hub = testHub({ webRoot: web.root });
      const response = await hub.get("/api/does-not-exist");
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json");
    } finally {
      web.cleanup();
    }
  });

  test("refuses to walk out of the web root", async () => {
    const web = builtWebRoot();
    try {
      const hub = testHub({ webRoot: join(web.root, "assets") });
      const response = await hub.get("/..%2f..%2fetc%2fpasswd");
      expect(response.status).not.toBe(200);
    } finally {
      web.cleanup();
    }
  });
});

describe("search expressions", () => {
  test("quotes every term so operators are matched as text", () => {
    expect(expectOk(literalQuery("deploy"))).toBe(`"deploy"`);
    expect(expectOk(literalQuery("green OR red"))).toBe(`"green" AND "OR" AND "red"`);
    expect(expectOk(literalQuery("NEAR(a b)"))).toBe(`"NEAR(a" AND "b)"`);
  });

  test("doubles an embedded quote rather than closing the phrase", () => {
    expect(expectOk(literalQuery(`say"s`))).toBe(`"say""s"`);
  });

  test("caps the number of terms", () => {
    const expression = expectOk(literalQuery("a b c d e f g h i j k"));
    expect(expression.split(" AND ").length).toBe(8);
  });

  test("rejects a query with nothing matchable in it", () => {
    expect(expectErr(literalQuery("   ")).field).toBe("q");
    expect(expectErr(literalQuery("--- ***")).field).toBe("q");
    expect(expectErr(literalQuery("x".repeat(257))).field).toBe("q");
  });

  test("keeps terms containing letters or digits from other scripts", () => {
    expect(expectOk(literalQuery("düşük"))).toBe(`"düşük"`);
  });
});

describe("request decoding", () => {
  test("accepts only a JSON object as a body", () => {
    expect(expectOk(decodeObject({ handle: "a" }))).toEqual({ handle: "a" });
    expect(expectErr(decodeObject(["a"])).field).toBe("body");
    expect(expectErr(decodeObject("a")).field).toBe("body");
    expect(expectErr(decodeObject(42)).field).toBe("body");
    expect(expectErr(decodeObject(null)).field).toBe("body");
  });

  test("distinguishes a missing field from a wrongly typed one", () => {
    expect(expectErr(requiredString({}, "handle")).message).toContain("required");
    expect(expectErr(requiredString({ handle: 42 }, "handle")).message).toContain("string");
    expect(expectOk(requiredString({ handle: "opus21" }, "handle"))).toBe("opus21");
  });

  test("rejects a number that is not an integer", () => {
    expect(expectOk(requiredInteger({ throughId: 4 }, "throughId"))).toBe(4);
    expect(expectErr(requiredInteger({ throughId: 4.5 }, "throughId")).field).toBe("throughId");
    expect(expectErr(requiredInteger({ throughId: "4" }, "throughId")).field).toBe("throughId");
  });

  test("treats an absent list as empty and rejects a mixed one", () => {
    expect(expectOk(optionalStringArray({}, "attachments"))).toEqual([]);
    expect(expectOk(optionalStringArray({ attachments: ["/a"] }, "attachments"))).toEqual(["/a"]);
    expect(expectErr(optionalStringArray({ attachments: ["/a", 2] }, "attachments")).field).toBe(
      "attachments",
    );
    expect(expectErr(optionalStringArray({ attachments: "/a" }, "attachments")).field).toBe(
      "attachments",
    );
  });
});
