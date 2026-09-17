// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  readClaudeSession,
  discoverSessions,
} from "./vendor/motif/readers/claude-code.js";
import {
  readCodexSession,
  discoverCodexSessions,
} from "./vendor/motif/readers/codex.js";
import type { MotifSession, MotifMessage } from "./vendor/motif/schema.js";
import { Store, sourceMessageId } from "./store.js";
import {
  canonical,
  assertLocalPath,
  git,
  hash,
  relativeFile,
  secureDirectory,
  within,
  readRegular,
  writePrivate,
  MAX_TRANSCRIPT_BYTES,
} from "./util.js";
import { redactValue, redact } from "./privacy.js";
import { extractExperiences } from "./experience.js";

export type Agent = "codex" | "claude-code";
export interface SessionFile {
  path: string;
  agent: Agent;
  parent?: string;
}
export interface SyncOptions {
  codexDir?: string;
  claudeDir?: string;
  aliases?: string[];
  files?: SessionFile[];
  force?: boolean;
}
const PIPELINE = "readers-4:links-3:extract-4:privacy-2";

export function discover(opts: SyncOptions): SessionFile[] {
  const codexDir =
    opts.codexDir ??
    process.env.CODEX_HOME ??
    path.join(os.homedir(), ".codex");
  const claudeDir =
    opts.claudeDir ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(os.homedir(), ".claude");
  const files: SessionFile[] = discoverCodexSessions(codexDir)
    .filter((f) => within(canonical(codexDir), canonical(f.path)))
    .map((f) => ({
      path: f.path,
      agent: "codex",
    }));
  for (const f of discoverSessions(claudeDir)) {
    if (!within(canonical(claudeDir), canonical(f.path))) continue;
    files.push({ path: f.path, agent: "claude-code" });
    const subdir = path.join(path.dirname(f.path), f.sessionId, "subagents");
    if (
      fs.existsSync(subdir) &&
      within(canonical(claudeDir), canonical(subdir))
    )
      for (const entry of fs.readdirSync(subdir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl"))
          files.push({
            path: path.join(subdir, entry.name),
            agent: "claude-code",
            parent: `claude-code:${f.sessionId}`,
          });
      }
  }
  return files;
}
/** Peek bounded metadata before opening a transcript; never infer scope from mangled filenames. */
export function peekCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    if (!fs.fstatSync(fd).isFile())
      throw new Error("Expected a regular transcript");
    const b = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    for (const line of b.subarray(0, n).toString("utf8").split("\n")) {
      try {
        const x = JSON.parse(line);
        const cwd =
          x.cwd ?? (x.type === "session_meta" ? x.payload?.cwd : undefined);
        if (typeof cwd === "string" && path.isAbsolute(cwd)) return cwd;
      } catch {
        /* incomplete line */
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function belongsToRepo(
  root: string,
  cwd: string,
  aliases: string[] = [],
): boolean {
  root = canonical(root);
  cwd = canonical(cwd);
  if (aliases.some((a) => within(canonical(a), cwd))) return true;
  // A nested independent git repository is not part of the parent.
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top && canonical(top) === root) return true;
  if (!top) return within(root, cwd);
  const a = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const b = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return !!a && !!b && canonical(a) === canonical(b);
}
export function sessionBase(
  root: string,
  cwd: string,
  aliases: string[] = [],
): string {
  for (const a of aliases)
    if (within(canonical(a), canonical(cwd))) return canonical(a);
  return canonical(git(cwd, ["rev-parse", "--show-toplevel"]) ?? root);
}
export function parseSession(file: SessionFile, raw?: string): MotifSession {
  const s =
    file.agent === "codex"
      ? readCodexSession(file.path, raw)
      : readClaudeSession(file.path, { subagent: !!file.parent, raw });
  if (file.parent) {
    // Claude agent IDs are local to their parent; avoid collisions across sessions.
    s.id = `${file.parent}/subagent:${s.sourceSessionId}`;
    s.parentSessionId = file.parent;
  }
  return s;
}
export function actionKind(m: MotifMessage): string {
  const name = m.toolName ?? "";
  const args: any = m.toolInput;
  const cmd =
    typeof args === "object" ? (args?.command ?? args?.cmd ?? "") : "";
  if (/edit|write|apply_patch/i.test(name)) return "EDITED";
  if (
    /read|view|open_file/i.test(name) ||
    /(?:^|[;&|]\s*)(?:cat|sed|head|tail)\s/.test(cmd)
  )
    return "READ";
  if (/grep|glob|search/i.test(name) || /(?:^|\s)(?:rg|grep|find)\s/.test(cmd))
    return "SEARCHED";
  if (/\b(?:test|pytest|vitest|jest|cargo test|go test)\b/.test(cmd))
    return "RAN_TEST";
  if (/bash|shell|exec_command|terminal/i.test(name)) return "RAN_COMMAND";
  if (/agent|spawn|task/i.test(name)) return "DELEGATED";
  return "USED_TOOL";
}
export function codeReferences(
  store: Store,
  text: string,
  base: string,
  cwd = base,
): string[] {
  const found = new Set<string>();
  // Path-shaped strings only, no basename/suffix matching across unrelated directories.
  const paths =
    text.match(
      /(?:\/[\w.@+ -]+)?(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|c|cc|cpp|h|cs|md|json|ya?ml|sql|toml|sh|css)(?::\d+(?::\d+)?)?/g,
    ) ?? [];
  for (const p of paths) {
    const rel = relativeFile(
      store.root,
      path.isAbsolute(p) ? p : path.resolve(cwd, p),
      base,
    );
    if (rel && store.get(`file:${rel}`)) found.add(`file:${rel}`);
  }
  return [...found];
}
export function importSession(
  store: Store,
  file: SessionFile,
  opts: SyncOptions = {},
): { imported: boolean; experiences: number; messages: number } {
  const stat = fs.lstatSync(file.path);
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES)
    throw new Error("Expected a regular transcript no larger than 128 MiB");
  const previous = store.db
    .prepare("SELECT * FROM ingestion WHERE source_path=?")
    .get(file.path) as any;
  if (
    !opts.force &&
    previous?.mtime === stat.mtimeMs &&
    previous?.size === stat.size &&
    previous?.pipeline === PIPELINE
  )
    return { imported: false, experiences: 0, messages: 0 };
  const rawBytes = readRegular(file.path);
  const raw = rawBytes.toString("utf8");
  const s = redactValue(parseSession(file, raw));
  if (!belongsToRepo(store.root, s.projectPath, opts.aliases) || !s.projectPath)
    throw new Error("Transcript project does not match repository");
  const priorCount = (
    store.db
      .prepare(
        "SELECT count(*) AS n FROM messages m JOIN nodes n ON n.id=m.id WHERE m.session_id=? AND n.active=1",
      )
      .get(s.id) as any
  ).n;
  if (
    s.meta.parseErrors > 0 &&
    s.messages.filter((m) => m.role !== "reasoning").length < priorCount
  )
    throw new Error(
      "Partial/corrupt transcript would shrink imported history; retry after the writer finishes.",
    );
  const base = sessionBase(store.root, s.projectPath, opts.aliases);
  const digest = hash(rawBytes);
  const archive = `${hash(s.id).slice(0, 24)}-${digest.slice(0, 16)}.jsonl.gz`;
  const rawDir = path.join(store.dir, "raw");
  assertLocalPath(store.root, path.join(rawDir, archive));
  secureDirectory(rawDir);
  // Exact original bytes stay local, including unknown event types and abandoned branches.
  // Redaction happens at every query/export boundary, not by destroying the evidence.
  if (!fs.existsSync(path.join(rawDir, archive)))
    writePrivate(path.join(rawDir, archive), gzipSync(rawBytes));
  let count = 0;
  store.db.transaction(() => {
    store.put({
      id: s.id,
      kind: "session",
      label: s.title ?? s.sourceSessionId,
      data: {
        agent: s.source,
        updatedAt: s.updatedAt,
        parent: s.parentSessionId,
        handoffFrom: s.handoffFrom,
        commit: s.gitCommit,
        ...s.meta,
      },
    });
    store.db
      .prepare(
        `INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_path=excluded.source_path,source_hash=excluded.source_hash,archive=excluded.archive,cwd=excluded.cwd,updated_at=excluded.updated_at,data=excluded.data`,
      )
      .run(
        s.id,
        file.path,
        digest,
        archive,
        s.projectPath,
        s.source,
        s.updatedAt,
        JSON.stringify({ ...s, messages: undefined, base }),
      );
    // Rebuild normalized active path atomically on append/rewind. Keep old raw snapshots.
    // Claims survive as inactive historical records if their evidence was removed.
    store.db
      .prepare(
        "UPDATE nodes SET active=0 WHERE id IN (SELECT id FROM messages WHERE session_id=?)",
      )
      .run(s.id);
    store.db
      .prepare(
        "DELETE FROM edges WHERE source=? AND kind IN ('READ','EDITED','SEARCHED','RAN_TEST','RAN_COMMAND','USED_TOOL','MENTIONS')",
      )
      .run(s.id);
    const activeIds = new Set<string>();
    const calls = new Map<string, string>();
    let task: string | undefined;
    for (const [seq, m] of s.messages.entries()) {
      if (m.role === "reasoning") continue;
      const id = sourceMessageId(s.id, m);
      activeIds.add(id);
      if (m.role === "user") task = id;
      const body = m.text ?? JSON.stringify(m.toolInput ?? {});
      store.put(
        {
          id,
          kind:
            m.role === "tool_call"
              ? "action"
              : m.role === "user"
                ? "task"
                : "message",
          label: m.toolName ?? m.role,
          body,
          data: {
            role: m.role,
            sourceLine: m.sourceLine,
            sourceId: m.id,
            sessionId: s.id,
            task,
            timestamp: m.timestamp,
            archive,
          },
        },
        m.role === "assistant",
      );
      store.db
        .prepare("INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?)")
        .run(
          id,
          s.id,
          m.id,
          seq,
          m.sourceLine ?? null,
          m.role,
          JSON.stringify(m),
        );
      store.edge(s.id, id, "CONTAINS");
      if (task && task !== id) store.edge(task, id, "HAS_STEP");
      if (m.role === "tool_call" && m.toolCallId) calls.set(m.toolCallId, id);
      if (m.role === "tool_result" && m.toolCallId && calls.has(m.toolCallId))
        store.edge(calls.get(m.toolCallId)!, id, "RESULTED_IN");
      store.db
        .prepare(
          "DELETE FROM edges WHERE source=? AND kind IN ('READ','EDITED','SEARCHED','RAN_TEST','RAN_COMMAND','USED_TOOL','MENTIONS')",
        )
        .run(id);
      // Link known filenames in normalized messages; tool outputs do not establish file ownership.
      if (m.role !== "tool_result") {
        const kind = m.role === "tool_call" ? actionKind(m) : "MENTIONS";
        for (const target of codeReferences(store, body, base, s.projectPath)) {
          store.edge(id, target, kind, {
            basis: "explicit-path",
            sourceLine: m.sourceLine,
          });
          store.edge(s.id, target, kind);
        }
      }
    }
    // Inactive steps remain inspectable with their archived evidence, but cannot influence recall.
    store.db
      .prepare(
        `UPDATE nodes SET active=0 WHERE id IN (SELECT e.id FROM experience e WHERE e.session_id=? AND e.extractor!='agent-recorded')`,
      )
      .run(s.id);
    count = extractExperiences(store, s, base, archive);
    store.db
      .prepare("INSERT OR REPLACE INTO ingestion VALUES (?,?,?,?,?)")
      .run(file.path, stat.mtimeMs, stat.size, s.id, PIPELINE);
  })();
  return {
    imported: true,
    experiences: count,
    messages: s.messages.filter((m) => m.role !== "reasoning").length,
  };
}
export function syncSessions(store: Store, opts: SyncOptions = {}) {
  const report = {
    discovered: 0,
    matched: 0,
    imported: 0,
    unchanged: 0,
    excluded: 0,
    messages: 0,
    experiences: 0,
    errors: [] as { path: string; error: string }[],
  };
  const files = opts.files ?? discover(opts);
  for (const file of files) {
    report.discovered++;
    try {
      const cwd = peekCwd(file.path);
      if (!cwd || !belongsToRepo(store.root, cwd, opts.aliases)) {
        report.excluded++;
        continue;
      }
      report.matched++;
      const r = importSession(store, file, opts);
      if (r.imported) report.imported++;
      else report.unchanged++;
      report.messages += r.messages;
      report.experiences += r.experiences;
    } catch (err) {
      report.errors.push({ path: file.path, error: String(err) });
    }
  }
  // Parents may sort after children; resolve lineage after all inserts.
  for (const node of store.nodes("session")) {
    if (node.data.parent && store.get(node.data.parent))
      store.edge(node.data.parent, node.id, "SPAWNED");
    if (node.data.handoffFrom && store.get(node.data.handoffFrom))
      store.edge(node.data.handoffFrom, node.id, "CONTINUES");
  }
  return report;
}
export function evidence(store: Store, id: string, radius = 1) {
  radius = Math.min(4, Math.max(0, Math.floor(radius)));
  const node = store.get(id);
  if (!node) throw new Error("Unknown node");
  const refs =
    node.kind === "experience"
      ? store
          .edges(id)
          .filter((e) => e.source === id && e.kind === "EVIDENCED_BY")
          .map((e) => store.get(e.target)!)
      : [node];
  return refs
    .filter(Boolean)
    .slice(0, 6)
    .map((ref) => {
      const session = store.db
        .prepare("SELECT * FROM sessions WHERE id=?")
        .get(ref.data.sessionId) as any;
      if (!session)
        return { id: ref.id, text: redact(ref.body).slice(0, 10000) };
      const line = ref.data.sourceLine;
      const archive = ref.data.archive ?? session.archive;
      if (!line || path.basename(archive) !== archive)
        return { id: ref.id, text: redact(ref.body).slice(0, 10000) };
      const archivePath = path.join(store.dir, "raw", archive);
      assertLocalPath(store.root, archivePath);
      const lines = gunzipSync(readRegular(archivePath), {
        maxOutputLength: MAX_TRANSCRIPT_BYTES,
      })
        .toString("utf8")
        .split("\n");
      return {
        id: ref.id,
        sessionId: ref.data.sessionId,
        sourceLine: line,
        archive,
        active: !!ref.active,
        text: redact(ref.body).slice(0, 10000),
        raw: lines
          .slice(Math.max(0, line - 1 - radius), line + radius)
          .map((text, i) => {
            let data: any;
            try {
              data = JSON.parse(text);
              // Do not expose private reasoning, injected prompts or arbitrary neighboring context.
              if (
                data.type === "session_meta" ||
                data.type === "turn_context" ||
                data.payload?.type === "reasoning" ||
                data.payload?.channel === "analysis" ||
                ["developer", "system"].includes(data.payload?.role)
              )
                return {
                  line: Math.max(0, line - 1 - radius) + i + 1,
                  text: "[metadata or reasoning omitted]",
                };
              if (Array.isArray(data.message?.content))
                data.message.content = data.message.content.filter(
                  (b: any) =>
                    !["thinking", "redacted_thinking"].includes(b.type),
                );
              text = JSON.stringify(redactValue(data));
            } catch {
              text = "[unparseable source line; original preserved locally]";
            }
            return {
              line: Math.max(0, line - 1 - radius) + i + 1,
              text: text.slice(0, 12000),
            };
          }),
      };
    });
}
