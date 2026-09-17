import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { integrate, ignoreLocalFiles } from "../src/integrate.js";
import { redact, redactValue } from "../src/privacy.js";
import { syncSessions, evidence } from "../src/sessions.js";
import { fixtureRepo, codexTranscript } from "./helpers.js";

describe("local security boundaries", () => {
  it("preserves original archive bytes even for an invalid trailing record", () => {
    const f = fixtureRepo();
    try {
      const file = f.write("history/bytes.jsonl", codexTranscript(f.root));
      fs.appendFileSync(file, Buffer.from([0xff, 0xfe, 10]));
      const result = syncSessions(f.store, {
        files: [{ path: file, agent: "codex" }],
      });
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(1);
      const archive = (
        f.store.db.prepare("SELECT archive FROM sessions").get() as {
          archive: string;
        }
      ).archive;
      expect(
        gunzipSync(fs.readFileSync(path.join(f.store.dir, "raw", archive))),
      ).toEqual(fs.readFileSync(file));
    } finally {
      f.close();
    }
  });
  it("redacts structured credentials and quoted JSON without removing benign fields", () => {
    const data = {
      nested: {
        api_key: "short",
        password: "tiny",
        Authorization: "Bearer opaque-value",
        "set-cookie": "session=private",
        tokenCount: 42,
      },
      text: 'password="hidden-value"',
    };
    const result = redactValue(data);
    expect(result.nested.tokenCount).toBe(42);
    for (const value of [
      "short",
      "tiny",
      "opaque-value",
      "session=private",
      "hidden-value",
    ])
      expect(JSON.stringify(result)).not.toContain(value);
    expect(redact('{"api_key":"opaque-value"}')).not.toContain("opaque-value");
    expect(redact("Authorization: Bearer opaque-value")).not.toContain(
      "opaque-value",
    );
    expect(
      redact("https://demo:private-password@example.invalid"),
    ).not.toContain("private-password");
  });

  it("refuses linked state directories, databases and SQLite sidecars", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "motif-security-")),
    );
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "motif-outside-"));
    const target = path.join(outside, "private");
    fs.writeFileSync(target, "untouched");
    try {
      fs.symlinkSync(outside, path.join(root, ".rex"));
      expect(() => new Store(root, { create: true })).toThrow(/link/);
      fs.unlinkSync(path.join(root, ".rex"));
      fs.mkdirSync(path.join(root, ".rex"));
      for (const name of [
        "graph.db",
        "graph.db-wal",
        "graph.db-shm",
        "graph.db-journal",
      ]) {
        const file = path.join(root, ".rex", name);
        fs.symlinkSync(target, file);
        expect(() => new Store(root, { create: true })).toThrow(/link/);
        fs.unlinkSync(file);
      }
      fs.linkSync(target, path.join(root, ".rex", "graph.db"));
      expect(() => new Store(root, { create: true })).toThrow(/link/);
      expect(fs.readFileSync(target, "utf8")).toBe("untouched");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("validates both integration paths before writes and keeps print mode read only", () => {
    const f = fixtureRepo();
    try {
      const target = f.write("private-config", "{}");
      fs.symlinkSync(target, path.join(f.root, ".mcp.json"));
      expect(() => integrate(f.store, "/workspace/motif/dist/cli.js")).toThrow(
        /link/,
      );
      expect(fs.existsSync(path.join(f.root, ".codex"))).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe("{}");
      expect(
        integrate(f.store, "/workspace/motif/dist/cli.js", true).claude,
      ).toBeDefined();
      fs.unlinkSync(path.join(f.root, ".mcp.json"));
      fs.unlinkSync(path.join(f.root, ".git", "info", "exclude"));
      fs.symlinkSync(target, path.join(f.root, ".git", "info", "exclude"));
      expect(() => ignoreLocalFiles(f.store)).toThrow(/link/);
    } finally {
      f.close();
    }
  });

  it("rejects linked transcript inputs and linked raw archives without exposing their target", () => {
    const f = fixtureRepo();
    try {
      const original = f.write("history/source.jsonl", codexTranscript(f.root));
      const link = path.join(f.root, "history", "linked.jsonl");
      fs.symlinkSync(original, link);
      expect(
        syncSessions(f.store, { files: [{ path: link, agent: "codex" }] })
          .errors,
      ).toHaveLength(1);
      expect(
        syncSessions(f.store, { files: [{ path: original, agent: "codex" }] })
          .imported,
      ).toBe(1);
      const node = f.store.nodes("experience").find((n) => n.active)!;
      const ref = evidence(f.store, node.id, 0)[0];
      const archive = path.join(f.store.dir, "raw", ref.archive!);
      fs.unlinkSync(archive);
      fs.symlinkSync(original, archive);
      expect(() => evidence(f.store, node.id, 0)).toThrow(/link/);
    } finally {
      f.close();
    }
  });
});
