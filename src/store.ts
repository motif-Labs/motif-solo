// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  assertLocalPath,
  canonical,
  hash,
  repoRoot,
  secureDirectory,
} from "./util.js";

export interface Node {
  id: string;
  kind: string;
  label: string;
  body: string;
  path: string | null;
  start: number | null;
  end: number | null;
  hash: string | null;
  active: number;
  data: Record<string, any>;
}
export interface Edge {
  source: string;
  target: string;
  kind: string;
  data: Record<string, any>;
}
export class Store {
  db: Database.Database;
  root: string;
  dir: string;
  constructor(root: string, opts: { create?: boolean; dir?: string } = {}) {
    this.root = repoRoot(root);
    this.dir = opts.dir ?? path.join(this.root, ".rex");
    const file = path.join(this.dir, "graph.db");
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      assertLocalPath(this.root, file + suffix);
    if (!opts.create && !fs.existsSync(file))
      throw new Error("No experience graph. Run rex init first.");
    secureDirectory(this.dir);
    this.db = new Database(file);
    fs.chmodSync(file, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 10000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) {
      this.db.close();
      throw new Error("Graph schema is newer than this CLI. Upgrade rex.");
    }
    if (version === 0)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '', path TEXT, start INTEGER, end INTEGER, hash TEXT,
          active INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL DEFAULT '{}');
        CREATE INDEX nodes_kind ON nodes(kind, active);
        CREATE INDEX nodes_path ON nodes(path, active);
        CREATE TABLE edges(source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, kind TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(source,target,kind));
        CREATE INDEX edges_target ON edges(target,kind);
        CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, label, body, tokenize='porter unicode61');
        CREATE TRIGGER node_ad AFTER DELETE ON nodes BEGIN DELETE FROM search WHERE id=old.id; END;
        CREATE TABLE sessions(id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          source_path TEXT NOT NULL, source_hash TEXT NOT NULL, archive TEXT NOT NULL,
          cwd TEXT NOT NULL, agent TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE messages(id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL, seq INTEGER NOT NULL, source_line INTEGER, role TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(session_id,source_id));
        CREATE INDEX messages_session ON messages(session_id,seq);
        CREATE TABLE experience(id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, confidence REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'reported', extractor TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE ingestion(source_path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL,
          session_id TEXT NOT NULL, pipeline TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      })();
    const owner = this.meta("root");
    if (owner && canonical(owner) !== this.root) {
      this.db.close();
      throw new Error(
        "This graph belongs to another repository path. Reinitialize in the moved checkout.",
      );
    }
    if (!owner) this.setMeta("root", this.root);
  }
  meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as any
    )?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, value);
  }
  put(
    n: Partial<Node> & Pick<Node, "id" | "kind" | "label">,
    searchable = true,
  ): void {
    const node = {
      body: "",
      path: null,
      start: null,
      end: null,
      hash: null,
      active: 1,
      data: {},
      ...n,
    };
    this.db
      .prepare(
        `INSERT INTO nodes VALUES (@id,@kind,@label,@body,@path,@start,@end,@hash,@active,@data)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,body=excluded.body,path=excluded.path,
      start=excluded.start,end=excluded.end,hash=excluded.hash,active=excluded.active,data=excluded.data`,
      )
      .run({ ...node, data: JSON.stringify(node.data) });
    this.db.prepare("DELETE FROM search WHERE id=?").run(node.id);
    if (searchable)
      this.db
        .prepare("INSERT INTO search VALUES (?,?,?)")
        .run(node.id, node.label, node.body);
  }
  get(id: string): Node | undefined {
    const r = this.db.prepare("SELECT * FROM nodes WHERE id=?").get(id) as any;
    return r ? { ...r, data: JSON.parse(r.data) } : undefined;
  }
  nodes(kind?: string): Node[] {
    return (
      this.db
        .prepare(`SELECT * FROM nodes ${kind ? "WHERE kind=?" : ""}`)
        .all(...(kind ? [kind] : [])) as any[]
    ).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  edge(
    source: string,
    target: string,
    kind: string,
    data: Record<string, any> = {},
  ): void {
    this.db
      .prepare("INSERT OR REPLACE INTO edges VALUES (?,?,?,?)")
      .run(source, target, kind, JSON.stringify(data));
  }
  edges(id: string): Edge[] {
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE source=? OR target=?")
        .all(id, id) as any[]
    ).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  stats() {
    return {
      nodes: this.db
        .prepare(
          "SELECT kind,active,count(*) AS count FROM nodes GROUP BY kind,active",
        )
        .all(),
      edges: this.db
        .prepare("SELECT kind,count(*) AS count FROM edges GROUP BY kind")
        .all(),
      sessions: this.db
        .prepare("SELECT agent,count(*) AS count FROM sessions GROUP BY agent")
        .all(),
      experience: this.db
        .prepare(
          "SELECT e.kind,e.status,count(*) AS count FROM experience e JOIN nodes n ON n.id=e.id WHERE n.active=1 GROUP BY e.kind,e.status",
        )
        .all(),
      indexedAt: this.meta("indexedAt"),
      schema: 1,
    };
  }
  close() {
    this.db.close();
  }
}
export const messageId = (session: string, id: string) =>
  `message:${hash(`${session}:${id}`).slice(0, 24)}`;

export const sourceMessageId = (
  session: string,
  m: import("./vendor/motif/schema.js").MotifMessage,
) =>
  messageId(
    session,
    `${m.id}@${hash(JSON.stringify({ role: m.role, text: m.text, toolName: m.toolName, toolInput: m.toolInput, toolCallId: m.toolCallId, isError: m.isError })).slice(0, 16)}`,
  );
