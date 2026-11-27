/**
 * FsStorage —— ProxyStorage 的本地文件系统实现。
 *
 * 定位：离线/私有部署或 docker 只读兜底。生产不推荐（多进程共享目录会 race）。
 *
 * 语义：
 *   - key 是相对路径，禁止绝对路径 / 路径穿越（安全守卫）
 *   - putText/putJSON 用 tmp + rename 保证原子；putIfAbsent 用 O_EXCL 保证 CAS
 *   - 目录自动创建
 *
 * TTL：不实现 sweeper（`fs.stat().mtime` 在某些容器 FS 上不可靠）——
 * 由运维用 tmpwatch / systemd-tmpfiles 清理。见方案 §3.3.3。
 */
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { ProxyStorage } from "./proxy-storage.js";

/** Matches atomic temp files created by putText: `<name>.<12-hex>.tmp`. */
const TMP_FILE_RE = /\.[0-9a-f]{12}\.tmp$/;

export class FsStorage implements ProxyStorage {
  readonly type = "fs" as const;
  private readonly rootAbs: string;

  constructor(private readonly root: string) {
    this.rootAbs = resolvePath(root);
  }

  private resolve(key: string): string {
    if (!key || key.length === 0) throw new Error(`[fs-storage] invalid empty key`);
    if (key.includes("\0") || key.includes("\\")) {
      throw new Error(`[fs-storage] invalid characters in key: ${key}`);
    }
    if (isAbsolute(key)) throw new Error(`[fs-storage] absolute path not allowed: ${key}`);
    const normalized = normalize(key);
    if (normalized.startsWith("..") || normalized.split(sep).includes("..")) {
      throw new Error(`[fs-storage] path traversal not allowed: ${key}`);
    }
    const full = resolvePath(this.rootAbs, normalized);
    // Double check: the resolved path must stay inside root.
    const rel = relative(this.rootAbs, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`[fs-storage] path escapes root: ${key}`);
    }
    return full;
  }

  private async ensureDir(filePath: string): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
  }

  async putText(key: string, value: string): Promise<void> {
    const full = this.resolve(key);
    await this.ensureDir(full);
    // atomic write: tmp + rename; clean up orphan tmp file if rename/write fails
    const tmp = full + "." + randomBytes(6).toString("hex") + ".tmp";
    try {
      await fs.writeFile(tmp, value, "utf-8");
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async putJSON(key: string, value: unknown): Promise<void> {
    return this.putText(key, JSON.stringify(value));
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    const full = this.resolve(key);
    await this.ensureDir(full);
    try {
      const handle = await fs.open(full, "wx"); // O_CREAT | O_EXCL
      try {
        await handle.writeFile(value, "utf-8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async putJSONIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.putTextIfAbsent(key, JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    const full = this.resolve(key);
    try {
      return await fs.readFile(full, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.getText(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    const full = this.resolve(key);
    try {
      await fs.access(full);
      return true;
    } catch {
      return false;
    }
  }

  async del(key: string): Promise<void> {
    const full = this.resolve(key);
    try {
      await fs.unlink(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async delPrefix(prefix: string): Promise<number> {
    const names = await this.listNames(prefix);
    let n = 0;
    const dirsToPrune = new Set<string>();
    for (const name of names) {
      const fullKey = prefix + name;
      await this.del(fullKey);
      n++;
      dirsToPrune.add(dirname(this.resolve(fullKey)));
    }
    // Best-effort cleanup of empty directories strictly inside rootAbs (never remove rootAbs itself).
    for (const dir of dirsToPrune) {
      await this.pruneEmptyDirsUpToRoot(dir);
    }
    return n;
  }

  async listNames(prefix: string): Promise<string[]> {
    if (prefix.includes("\0") || prefix.includes("\\") || isAbsolute(prefix)) {
      return [];
    }

    let walkRootAbs: string;
    let walkRelBase: string;

    if (!prefix) {
      walkRootAbs = this.rootAbs;
      walkRelBase = "";
    } else if (prefix.endsWith("/")) {
      const trimmedDir = prefix.replace(/\/+$/, "");
      try {
        walkRootAbs = trimmedDir ? this.resolve(trimmedDir) : this.rootAbs;
      } catch {
        return [];
      }
      walkRelBase = trimmedDir ? `${trimmedDir}/` : "";
    } else {
      const lastSlash = prefix.lastIndexOf("/");
      const parentDir = lastSlash === -1 ? "" : prefix.slice(0, lastSlash);
      try {
        walkRootAbs = parentDir ? this.resolve(parentDir) : this.rootAbs;
      } catch {
        return [];
      }
      walkRelBase = parentDir ? `${parentDir}/` : "";
    }

    const allKeys: string[] = [];
    await this.walk(walkRootAbs, walkRelBase, allKeys);

    const out: string[] = [];
    for (const fullKey of allKeys) {
      if (fullKey.startsWith(prefix)) {
        out.push(fullKey.slice(prefix.length));
      }
    }
    out.sort();
    return out;
  }

  private async pruneEmptyDirsUpToRoot(startDir: string): Promise<void> {
    let current = resolvePath(startDir);
    while (current !== this.rootAbs) {
      const rel = relative(this.rootAbs, current);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) break;
      try {
        await fs.rmdir(current);
      } catch {
        // Directory is non-empty or already removed; stop walking upward.
        break;
      }
      current = dirname(current);
    }
  }

  private async walk(absDir: string, relPrefix: string, out: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      if (!e.isDirectory() && TMP_FILE_RE.test(e.name)) {
        continue;
      }
      const relName = relPrefix + e.name;
      if (e.isDirectory()) {
        await this.walk(join(absDir, e.name), relName + "/", out);
      } else {
        out.push(relName);
      }
    }
  }
}
