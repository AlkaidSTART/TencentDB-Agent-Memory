import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsStorage } from "../fs-storage.js";
import { MemoryStorage } from "../memory-storage.js";
import { assertKeySegment, sessionDirOf } from "../key-utils.js";

describe("FsStorage", () => {
  let root: string;
  let storage: FsStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "fs-storage-test-"));
    storage = new FsStorage(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("matches MemoryStorage prefix semantics for listNames and delPrefix", async () => {
    const mem = new MemoryStorage();
    const keys = [
      "ttl/space1/file_a.json",
      "ttl/space1/file_b.json",
      "ttl/space1/other.json",
      "ttl/space1/nested/file_c.json",
      "ttl/space2/file_a.json",
    ];

    for (const k of keys) {
      await storage.putText(k, k);
      await mem.putText(k, k);
    }

    // Trailing-slash directory prefix
    expect(await storage.listNames("ttl/space1/")).toEqual(
      (await mem.listNames("ttl/space1/")).sort(),
    );

    // Non-trailing-slash directory prefix
    expect(await storage.listNames("ttl/space1")).toEqual(
      (await mem.listNames("ttl/space1")).sort(),
    );

    // Partial filename prefix
    expect(await storage.listNames("ttl/space1/file_")).toEqual(
      (await mem.listNames("ttl/space1/file_")).sort(),
    );

    // delPrefix with partial filename prefix must NOT delete sibling files
    const removed = await storage.delPrefix("ttl/space1/file_");
    expect(removed).toBe(2);
    expect(await storage.exists("ttl/space1/file_a.json")).toBe(false);
    expect(await storage.exists("ttl/space1/file_b.json")).toBe(false);
    expect(await storage.exists("ttl/space1/other.json")).toBe(true);
    expect(await storage.exists("ttl/space1/nested/file_c.json")).toBe(true);
  });

  it("preserves storage root directory when delPrefix is called with empty prefix", async () => {
    await storage.putText("ttl/s1/a.json", "1");
    await storage.putText("nottl/s2/b.json", "2");

    const removed = await storage.delPrefix("");
    expect(removed).toBe(2);
    expect(await storage.listNames("")).toEqual([]);

    // Root directory must still exist and remain writable
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);
    await storage.putText("ttl/s1/new.json", "3");
    expect(await storage.getText("ttl/s1/new.json")).toBe("3");
  });

  it("ignores in-flight .tmp files during listNames and cleans up orphan tmp on rename failure", async () => {
    await storage.putText("ttl/s1/real.json", "ok");
    // Simulate an in-flight temp file from a concurrent putText
    await fs.writeFile(join(root, "ttl/s1/real.json.abcdef012345.tmp"), "partial");

    expect(await storage.listNames("ttl/s1/")).toEqual(["real.json"]);

    // Force rename failure by creating a directory at the target key path
    await fs.mkdir(join(root, "ttl/s1/dir-collision"), { recursive: true });
    await expect(storage.putText("ttl/s1/dir-collision", "boom")).rejects.toThrow();

    const rawEntries = await fs.readdir(join(root, "ttl/s1"));
    const orphanTmps = rawEntries.filter((name) => name.startsWith("dir-collision."));
    expect(orphanTmps).toEqual([]);
  });

  it("rejects path traversal, backslashes, and null bytes", async () => {
    await expect(storage.putText("../escape.json", "x")).rejects.toThrow();
    await expect(storage.putText("ttl/../../escape.json", "x")).rejects.toThrow();
    await expect(storage.putText("ttl/a\\b.json", "x")).rejects.toThrow();
    await expect(storage.putText("ttl/a\0b.json", "x")).rejects.toThrow();
  });
});

describe("key-utils assertKeySegment", () => {
  it("rejects dot, traversal, slashes, backslashes, and null bytes", () => {
    for (const bad of ["", ".", "..", "a..b", "a/b", "a\\b", "a\0b"]) {
      expect(() => assertKeySegment("sessionId", bad)).toThrow();
    }
    expect(() => sessionDirOf("ttl", ".", "u1", "codex", "s1")).toThrow();
    expect(sessionDirOf("ttl", "space-1", "user_1", "codex", "sess-1")).toBe(
      "ttl/space-1/user_1/codex/sess-1/",
    );
  });
});
