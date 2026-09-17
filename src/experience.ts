// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store, messageId, sourceMessageId, type Node } from "./store.js";
import {
  assertLocalPath,
  readRegular,
  hash,
  git,
  relativeFile,
  canonical,
  within,
} from "./util.js";
import { redact } from "./privacy.js";
import { codeReferences, actionKind } from "./sessions.js";
import type { MotifSession } from "./vendor/motif/schema.js";

export const ExperienceKind = z.enum([
  "decision",
  "failure",
  "solution",
  "root_cause",
  "workaround",
  "convention",
  "gotcha",
  "useful_test",
  "command",
]);
export const RecordInput = z.object({
  sessionId: z.string(),
  kind: ExperienceKind,
  summary: z.string().min(15).max(1800),
  evidence: z
    .array(
      z.object({ messageId: z.string(), quote: z.string().min(8).max(4000) }),
    )
    .min(1)
    .max(6),
  code: z.array(z.string()).min(1).max(10),
  reason: z.string().max(800).optional(),
  outcome: z.string().max(800).optional(),
  relation: z
    .object({
      kind: z.enum(["SUPERSEDES", "CONTRADICTS", "RESOLVES"]),
      target: z.string(),
    })
    .optional(),
});
type Kind = z.infer<typeof ExperienceKind>;

/** This is a high-precision bootstrap, not an LLM claiming to understand every session. */
export function classifyClaim(text: string): Kind | undefined {
  if (
    text.length < 30 ||
    text.length > 1800 ||
    /^(?:USER|SYSTEM|DEVELOPER):|\[external_agent_tool_|^(?:export |import |const |function |describe\(|it\(|old =|new =|\"\w+\":|\/\*|\d+\t)/i.test(
      text,
    )
  )
    return;
  if (
    /\b(?:I(?:'ll| will)|we(?:'ll| will)|let(?:'s| us)|going to|plan to|should try|could try|might fix|would fix|if we)\b/i.test(
      text,
    )
  )
    return;
  if (
    /\b(?:root cause|caused by|reason (?:was|is)|bug was|problem was)\b/i.test(
      text,
    )
  )
    return "root_cause";
  if (
    /\b(?:failed because|didn['’]t work|doesn['’]t work because|ruled out|abandoned|unsuccessful|attempt .{0,45}failed)\b/i.test(
      text,
    )
  )
    return "failure";
  if (/\b(?:workaround|worked around)\b/i.test(text)) return "workaround";
  const solved =
    /(?:^|[.!?]\s+|:\s+)(?:[-*#]+\s*)?(?:I |we )?(?:fixed|resolved|solved)\b|\b(?:the fix was|now passes|tests? (?:now )?passed)\b/i.test(
      text,
    );
  if (
    solved &&
    !/\b(?:not fixed|not resolved|not solved|not yet|not tested|may have|might have|fixed (?:string|size|width|length))\b/i.test(
      text,
    )
  )
    return "solution";
  if (
    /expected vs actual|regression.{0,40}(?:caused|breaks)|\bbug\b.{0,60}\b(?:causes|drops|loses|fails)\b/i.test(
      text,
    )
  )
    return "gotcha";
  if (
    /\b(?:decided|chose|chosen|switched to|replaced .{0,60}with|kept .{0,60}because|instead of .{0,60}because)\b/i.test(
      text,
    )
  )
    return "decision";
  if (
    /\b(?:gotcha|beware|requires .{0,70}otherwise|only works (?:when|if)|incompatible with)\b/i.test(
      text,
    )
  )
    return "gotcha";
  if (
    /\b(?:convention|must always|never .{0,60}because|by convention)\b/i.test(
      text,
    )
  )
    return "convention";
}
function snippets(text: string): string[] {
  // Keep a whole paragraph when short; split large paragraphs by sentence/line.
  return text
    .replace(/```[\s\S]*?```/g, "\n")
    .split(/\n{2,}/)
    .flatMap((p) =>
      p.length > 1100 ? p.split(/\n|(?<=[.!?])\s+(?=[A-Z])/u) : [p],
    )
    .map((p) => p.trim())
    .filter(Boolean);
}
export function exitStatus(text: string): number | undefined {
  const m = text.match(
    /(?:Process exited with code|exit[_ ]code["']?\s*[:=]?|Exit code:)\s*(-?\d+)/i,
  );
  return m ? Number(m[1]) : undefined;
}
function anchor(store: Store, id: string, commit?: string) {
  const n = store.get(id)!;
  let historicalHash: string | undefined;
  if (n.path && commit && /^[0-9a-f]{7,40}$/.test(commit)) {
    // Git returns the original blob (without trimEnd) through cat-file by hash below.
    const blob = git(store.root, ["rev-parse", `${commit}:${n.path}`]);
    historicalHash = blob && /^[0-9a-f]{40,64}$/.test(blob) ? blob : undefined;
  }
  return {
    basis: "explicit-reference",
    indexedHash: n.hash,
    fileHash: n.path ? store.get(`file:${n.path}`)?.hash : undefined,
    historicalBlob: historicalHash,
    sessionStartCommit: commit,
  };
}
function saveClaim(
  store: Store,
  opts: {
    session: MotifSession;
    kind: Kind;
    text: string;
    messages: string[];
    targets: string[];
    confidence: number;
    status?: string;
    extractor?: string;
    basis?: string;
    extra?: Record<string, any>;
  },
): string {
  const id = `experience:${hash(`${opts.session.id}:${opts.kind}:${opts.text}`).slice(0, 24)}`;
  const old = store.get(id);
  store.put({
    id,
    kind: "experience",
    label: opts.text.replace(/\s+/g, " ").slice(0, 120),
    body: opts.text,
    data: { kind: opts.kind, sessionId: opts.session.id, ...opts.extra },
  });
  store.db
    .prepare(
      `INSERT INTO experience VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence,status=CASE WHEN experience.status='contested' THEN 'contested' ELSE excluded.status END`,
    )
    .run(
      id,
      opts.session.id,
      opts.kind,
      opts.confidence,
      opts.status ?? "reported",
      opts.extractor ?? "rules-v1",
      opts.session.updatedAt || new Date().toISOString(),
    );
  store.edge(opts.session.id, id, "LEARNED");
  for (const msg of opts.messages) store.edge(id, msg, "EVIDENCED_BY");
  for (const target of opts.targets) {
    // Reingestion must never reset the baseline of an existing experience.
    const prior =
      old &&
      store
        .edges(id)
        .find(
          (e) =>
            e.source === id && e.target === target && e.kind === "CONCERNS",
        );
    store.edge(
      id,
      target,
      "CONCERNS",
      prior?.data ?? {
        ...anchor(store, target, opts.session.gitCommit),
        basis: opts.basis ?? "explicit-reference",
      },
    );
  }
  return id;
}
export function extractExperiences(
  store: Store,
  session: MotifSession,
  base: string,
  archive: string,
): number {
  const symbols = (
    store.db
      .prepare(
        "SELECT * FROM nodes WHERE kind IN ('function','class','method','interface','type') AND active=1",
      )
      .all() as any[]
  ).map((n) => ({ ...n, data: JSON.parse(n.data) })) as Node[];
  const calls = new Map<
    string,
    { message: string; cmd: string; kind: string; targets: string[] }
  >();
  let recent: string[] = [],
    distance = 0;
  const extracted = new Set<string>();
  for (const m of session.messages) {
    distance++;
    const msg = sourceMessageId(session.id, m);
    if (m.role === "user") {
      recent = [];
      distance = 0;
    }
    if (m.role === "tool_call") {
      const kind = actionKind(m),
        input =
          typeof m.toolInput === "string"
            ? m.toolInput
            : JSON.stringify(m.toolInput ?? {});
      const targets = codeReferences(store, input, base, session.projectPath);
      if (targets.length && ["EDITED", "RAN_TEST"].includes(kind)) {
        recent = targets.slice(0, 3);
        distance = 0;
      }
      if (m.toolCallId)
        calls.set(m.toolCallId, { message: msg, cmd: input, kind, targets });
    }
    if (m.role === "tool_result" && m.toolCallId) {
      const call = calls.get(m.toolCallId),
        exit = exitStatus(m.text ?? "");
      const toolError = m.isError === true;
      if (
        call &&
        ["RAN_COMMAND", "RAN_TEST", "EDITED"].includes(call.kind) &&
        (exit !== undefined || toolError) &&
        (toolError || exit !== 0 || call.kind === "RAN_TEST")
      ) {
        // A nonzero command is an observation, never proof that a whole approach failed.
        const kind = exit === 0 && !toolError ? "useful_test" : "failure";
        const excerpt = (m.text ?? "").trim().slice(-850);
        const outcome =
          toolError && exit === undefined
            ? "Tool reported an error (execution/exit status unknown)"
            : exit === 0 && !toolError
              ? "Test command exited successfully"
              : `Tool result reported exit code ${exit}${toolError ? " and an error" : ""}`;
        const text = `${outcome}: ${call.cmd.slice(0, 350)}\n${excerpt}`;
        extracted.add(
          saveClaim(store, {
            session,
            kind,
            text,
            messages: [call.message, msg],
            targets: call.targets,
            confidence: 1,
            status: "observed",
            extra: {
              exitCode: exit ?? null,
              toolError,
              archive,
              observation: "command-outcome; not a durable causal claim",
            },
          }),
        );
      }
    }
    if (m.role !== "assistant" || !m.text) continue;
    for (const text of snippets(m.text)) {
      const kind = classifyClaim(text);
      if (!kind) continue;
      let targets = codeReferences(store, text, base, session.projectPath);
      const explicit = targets.length > 0;
      // Use exact symbol names only when unique, or disambiguated by an explicit file.
      const names = [...text.matchAll(/\b([A-Za-z_$][\w$]{3,})\s*\(/g)].map(
        (m) => m[1],
      );
      for (const name of names) {
        const matches = symbols.filter(
          (n) =>
            n.label.split(".").at(-1) === name &&
            (!targets.length || targets.includes(`file:${n.path}`)),
        );
        if (matches.length === 1) targets.push(matches[0].id);
      }
      let basis = "explicit-reference";
      if (!targets.length && distance <= 6 && recent.length) {
        targets = recent;
        basis = "nearby-tool-in-same-task; inferred";
      }
      // Do not promote uncited generic discussion to repository experience.
      if (!targets.length) continue;
      const because = text.match(
        /\b(?:because|caused by|root cause[: ]+)\s*([^\n]{8,300})/i,
      )?.[1];
      extracted.add(
        saveClaim(store, {
          session,
          kind,
          text,
          messages: [msg],
          targets: [...new Set(targets)],
          confidence: explicit ? 0.65 : 0.4,
          basis,
          extra: { reason: because, archive },
        }),
      );
    }
  }
  return extracted.size;
}
export function recordExperience(store: Store, value: unknown) {
  const input = RecordInput.parse(value);
  const row = store.db
    .prepare("SELECT data FROM sessions WHERE id=?")
    .get(input.sessionId) as any;
  if (!row) throw new Error("Import the source session first with rex sync.");
  const session = JSON.parse(row.data) as MotifSession;
  const refs = input.evidence.map((ref) => {
    const mapped = store.db
      .prepare("SELECT id FROM messages WHERE session_id=? AND source_id=?")
      .get(input.sessionId, ref.messageId) as any;
    const msg = store.get(ref.messageId) ?? (mapped && store.get(mapped.id));
    if (!msg || msg.data.sessionId !== input.sessionId || !msg.active)
      throw new Error(
        "Evidence must be an active message in the source session.",
      );
    if (!msg.body.includes(ref.quote))
      throw new Error(
        "Evidence quote does not exactly match the source message.",
      );
    return msg.id;
  });
  const targets = input.code.map((ref) => {
    const node =
      store.get(ref) ?? store.get(`file:${relativeFile(store.root, ref)}`);
    if (!node?.active || !node.path)
      throw new Error(`Unknown active code target: ${ref}`);
    return node.id;
  });
  if (input.relation && store.get(input.relation.target)?.kind !== "experience")
    throw new Error("Relation target must be an existing experience.");
  return store.db.transaction(() => {
    const id = saveClaim(store, {
      session,
      kind: input.kind,
      text: redact(input.summary),
      messages: refs,
      targets,
      confidence: 0.75,
      extractor: "agent-recorded",
      extra: {
        reason: redact(input.reason ?? ""),
        outcome: redact(input.outcome ?? ""),
      },
    });
    if (input.relation) {
      store.edge(id, input.relation.target, input.relation.kind, {
        basis: "agent-reported; inspect evidence",
      });
      // Disagreement stays visible. An agent cannot silently retire someone else's claim.
      if (input.relation.kind === "CONTRADICTS")
        store.db
          .prepare("UPDATE experience SET status='contested' WHERE id IN (?,?)")
          .run(id, input.relation.target);
    }
    return {
      id,
      status: (
        store.db
          .prepare("SELECT status FROM experience WHERE id=?")
          .get(id) as any
      ).status,
      evidence: refs,
    };
  })();
}
export function freshness(store: Store, node: Node) {
  const links = store
    .edges(node.id)
    .filter((e) => e.source === node.id && e.kind === "CONCERNS");
  const reasons: string[] = [];
  let changed = false;
  const files = new Map<string, string>();
  for (const link of links) {
    const code = store.get(link.target);
    if (!code?.path) continue;
    const full = path.join(store.root, code.path);
    if (!within(store.root, canonical(full)) || !fs.existsSync(full)) {
      changed = true;
      reasons.push(`${code.path}: deleted or outside repository`);
      continue;
    }
    let current = files.get(code.path);
    if (!current) {
      try {
        assertLocalPath(store.root, full);
        current = hash(readRegular(full, 1024 * 1024));
      } catch {
        changed = true;
        reasons.push(`${code.path}: unavailable or unsafe to read`);
        continue;
      }
      files.set(code.path, current);
    }
    if (link.data.fileHash && current !== link.data.fileHash) {
      changed = true;
      reasons.push(`${code.path}: changed since experience was indexed`);
    } else if (link.data.historicalBlob) {
      const blob = git(store.root, ["hash-object", "--", code.path]);
      if (blob && blob !== link.data.historicalBlob) {
        changed = true;
        reasons.push(
          `${code.path}: differs from session-start revision (may include the session's own fix)`,
        );
      }
    }
  }
  if (!reasons.length)
    reasons.push(
      links.length
        ? "No change since indexing; historical correctness has not been verified."
        : "No exact code anchor; command observation only.",
    );
  return {
    state: changed ? "changed" : "unverified",
    reasons: [...new Set(reasons)],
  };
}
