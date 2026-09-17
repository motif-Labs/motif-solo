import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fixtureRepo, codexTranscript, claudeTranscript } from "./helpers.js";
import { indexCode } from "../src/code.js";
import {
  importSession,
  syncSessions,
  belongsToRepo,
  evidence,
  codeReferences,
} from "../src/sessions.js";
import { recall, neighborhood } from "../src/retrieve.js";
import {
  classifyClaim,
  freshness,
  recordExperience,
} from "../src/experience.js";
import { redact } from "../src/privacy.js";
import { integrate } from "../src/integrate.js";

describe("connected code/session/experience graph", () => {
  it("resolves definitions, cross-file calls, imports and test links; tombstones removed symbols", () => {
    const f = fixtureRepo();
    try {
      const e = f.store.edges("symbol:src/token.ts#refreshToken");
      expect(
        e.some(
          (e) =>
            e.kind === "CALLS" &&
            e.target === "symbol:src/session.ts#serializeSession",
        ),
      ).toBe(true);
      expect(
        f.store.edges("file:src/token.ts").some((e) => e.kind === "TESTS"),
      ).toBe(true);
      f.write("src/token.ts", "export const value = 1;\n");
      indexCode(f.store);
      expect(f.store.get("symbol:src/token.ts#refreshToken")?.active).toBe(0);
      expect(
        f.store
          .edges("symbol:src/token.ts#refreshToken")
          .filter((e) => e.kind === "CALLS"),
      ).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  it("connects a Claude failure and a Codex solution to the same symbol with retrievable raw evidence", () => {
    const f = fixtureRepo();
    try {
      const a = f.write("history/claude.jsonl", claudeTranscript(f.root));
      const c = f.write("history/codex.jsonl", codexTranscript(f.root));
      importSession(f.store, { path: a, agent: "claude-code" });
      importSession(f.store, { path: c, agent: "codex" });
      const packet = recall(
        f.store,
        "refreshToken Redis TTL optimistic locking race",
        3000,
      );
      expect(
        packet.experience.some(
          (e) => e.kind === "failure" && e.text.includes("Redis TTL"),
        ),
      ).toBe(true);
      expect(
        packet.experience.some(
          (e) => e.kind === "solution" && e.session.startsWith("codex:"),
        ),
      ).toBe(true);
      const node = f.store
        .nodes("experience")
        .find(
          (n) => n.data.kind === "failure" && n.body.includes("Redis TTL"),
        )!;
      expect(
        f.store
          .edges(node.id)
          .some(
            (e) =>
              e.target === "symbol:src/token.ts#refreshToken" &&
              e.kind === "CONCERNS",
          ),
      ).toBe(true);
      const source = evidence(f.store, node.id, 0)[0];
      expect(source.raw?.[0].text).toContain("Optimistic locking");
      expect(source.sourceLine).toBe(2);
      const before = f.store.nodes("experience").length;
      importSession(
        f.store,
        { path: a, agent: "claude-code" },
        { force: true },
      );
      expect(f.store.nodes("experience")).toHaveLength(before);
      expect(f.store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      f.close();
    }
  });
  it("enforces the entire serialized packet budget, including provenance", () => {
    const f = fixtureRepo();
    try {
      importSession(f.store, {
        path: f.write("history/c.jsonl", codexTranscript(f.root)),
        agent: "codex",
      });
      for (const budget of [300, 500, 1000, 1800]) {
        const packet = recall(f.store, "refreshToken race", budget);
        expect(JSON.stringify(packet).length).toBeLessThanOrEqual(budget * 4);
        expect(packet.stats.tokensApprox).toBeLessThanOrEqual(budget);
      }
      expect(recall(f.store, "zzzzunrelatedneverfound").experience).toEqual([]);
    } finally {
      f.close();
    }
  });
  it("checks live file changes without sync and never refreshes old baselines during reingestion", () => {
    const f = fixtureRepo();
    try {
      const p = f.write("history/c.jsonl", codexTranscript(f.root));
      importSession(f.store, { path: p, agent: "codex" });
      const n = f.store
        .nodes("experience")
        .find((n) => n.data.kind === "solution")!;
      expect(freshness(f.store, n).state).toBe("unverified");
      f.write(
        "src/token.ts",
        'export function refreshToken() { return "different"; }\n',
      );
      expect(freshness(f.store, n).state).toBe("changed");
      indexCode(f.store);
      importSession(f.store, { path: p, agent: "codex" }, { force: true });
      expect(freshness(f.store, n).state).toBe("changed");
      fs.unlinkSync(path.join(f.root, "src/token.ts"));
      expect(freshness(f.store, n).reasons.join()).toContain("deleted");
    } finally {
      f.close();
    }
  });
  it("withdraws rewound claims from retrieval and preserves the original raw snapshot", () => {
    const f = fixtureRepo();
    try {
      const p = f.write("history/claude.jsonl", claudeTranscript(f.root));
      importSession(f.store, { path: p, agent: "claude-code" });
      const n = f.store.nodes("experience")[0];
      f.write(
        "history/claude.jsonl",
        claudeTranscript(f.root, "No conclusion yet."),
      );
      importSession(
        f.store,
        { path: p, agent: "claude-code" },
        { force: true },
      );
      expect(recall(f.store, "Redis TTL").experience).toHaveLength(0);
      expect(f.store.get(n.id)?.active).toBe(0);
      expect(fs.readdirSync(path.join(f.store.dir, "raw"))).toHaveLength(2);
      expect(evidence(f.store, n.id, 0)[0].text).toContain(
        "Optimistic locking",
      );
      expect(evidence(f.store, n.id, 0)[0].raw?.[0].text).toContain(
        "Redis TTL",
      );
    } finally {
      f.close();
    }
  });
  it("validates recorded evidence and rejects unsupported or cross-session quotes", () => {
    const f = fixtureRepo();
    try {
      importSession(f.store, {
        path: f.write("history/c.jsonl", codexTranscript(f.root)),
        agent: "codex",
      });
      const m = f.store
        .nodes("message")
        .find((n) => n.data.role === "assistant")!;
      const value = {
        sessionId: m.data.sessionId,
        kind: "solution",
        summary: "Per-session serialization resolves the refresh race.",
        evidence: [
          { messageId: m.id, quote: "using per-session serialization" },
        ],
        code: ["src/token.ts"],
      };
      expect(recordExperience(f.store, value).status).toBe("reported");
      expect(() =>
        recordExperience(f.store, {
          ...value,
          evidence: [{ messageId: m.id, quote: "this never occurred" }],
        }),
      ).toThrow("quote");
      expect(() =>
        recordExperience(f.store, { ...value, code: ["../outside.ts"] }),
      ).toThrow("target");
    } finally {
      f.close();
    }
  });
  it("preserves contradictions across reimport instead of silently restoring a claim", () => {
    const f = fixtureRepo();
    try {
      const source = f.write("history/c.jsonl", codexTranscript(f.root));
      importSession(f.store, { path: source, agent: "codex" });
      const original = f.store
        .nodes("experience")
        .find((n) => n.data.kind === "solution")!;
      const m = f.store
        .nodes("message")
        .find((n) => n.data.role === "assistant")!;
      const recorded = recordExperience(f.store, {
        sessionId: m.data.sessionId,
        kind: "decision",
        summary: "The cited serialization finding requires further validation.",
        evidence: [
          { messageId: m.id, quote: "using per-session serialization" },
        ],
        code: ["src/token.ts"],
        relation: { kind: "CONTRADICTS", target: original.id },
      });
      expect(recorded.status).toBe("contested");
      importSession(f.store, { path: source, agent: "codex" }, { force: true });
      expect(
        (
          f.store.db
            .prepare("SELECT status FROM experience WHERE id=?")
            .get(original.id) as any
        ).status,
      ).toBe("contested");
      expect(
        recall(f.store, "refreshToken", 3000).experience.some(
          (e) => e.relatedClaims.length > 0 && e.status === "contested",
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
});
describe("scope and conservative extraction", () => {
  it("excludes unrelated and nested repositories; keeps a real worktree", () => {
    const f = fixtureRepo();
    try {
      expect(belongsToRepo(f.root, `${f.root}-other`)).toBe(false);
      const nested = path.join(f.root, "nested");
      fs.mkdirSync(nested);
      execFileSync("git", ["init", "-q", nested]);
      expect(belongsToRepo(f.root, nested)).toBe(false);
      const wt = path.join(f.root, "alternate");
      execFileSync("git", ["-C", f.root, "worktree", "add", "--detach", wt], {
        stdio: "ignore",
      });
      expect(belongsToRepo(f.root, wt)).toBe(true);
      const elsewhere = f.write(
        "history/other.jsonl",
        codexTranscript("/workspace/unrelated"),
      );
      const r = syncSessions(f.store, {
        files: [{ path: elsewhere, agent: "codex" }],
      });
      expect(r.excluded).toBe(1);
      expect(f.store.nodes("session")).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  it("requires exact paths and ignores plans and user speculation", () => {
    const f = fixtureRepo();
    try {
      expect(
        codeReferences(f.store, "/different/src/token.ts", f.root),
      ).toEqual([]);
      expect(
        codeReferences(f.store, `Updated ${f.root}/src/token.ts:2`, f.root),
      ).toContain("file:src/token.ts");
      expect(
        classifyClaim("I will fix the race in src/token.ts using a mutex."),
      ).toBeUndefined();
      expect(
        classifyClaim(
          "The bug is not fixed in src/token.ts and we have not tested it.",
        ),
      ).toBeUndefined();
      expect(
        classifyClaim("The root cause was a TTL race in src/token.ts."),
      ).toBe("root_cause");
      expect(
        classifyClaim(
          "The only dynamic SQL uses fixed string literals in src/token.ts.",
        ),
      ).toBeUndefined();
      expect(
        classifyClaim("The symbol is resolved by name in src/token.ts."),
      ).toBeUndefined();
      expect(
        classifyClaim(
          "[external_agent_tool_result]\nFile updated successfully in src/token.ts",
        ),
      ).toBeUndefined();
    } finally {
      f.close();
    }
  });
  it("redacts known credentials at retrieval boundaries", () => {
    const token = `sk-${"x".repeat(30)}`;
    expect(redact(`secret token ${token}`)).not.toContain(token);
    const f = fixtureRepo();
    try {
      importSession(f.store, {
        path: f.write(
          "history/c.jsonl",
          codexTranscript(
            f.root,
            `Fixed src/token.ts credential handling because ${token} was invalid.`,
          ),
        ),
        agent: "codex",
      });
      const n = f.store.nodes("experience")[0];
      expect(JSON.stringify(evidence(f.store, n.id, 0))).not.toContain(token);
    } finally {
      f.close();
    }
  });
  it("preserves integration configs and makes bounded graph exports", () => {
    const f = fixtureRepo();
    try {
      f.write(
        ".mcp.json",
        JSON.stringify({ mcpServers: { other: { command: "other" } } }),
      );
      f.write(".codex/config.toml", 'model = "example-model"\n');
      integrate(f.store, "/workspace/rex/dist/cli.js");
      integrate(f.store, "/workspace/rex/dist/cli.js");
      expect(
        JSON.parse(fs.readFileSync(path.join(f.root, ".mcp.json"), "utf8"))
          .mcpServers.other.command,
      ).toBe("other");
      expect(
        fs.readFileSync(path.join(f.root, ".codex/config.toml"), "utf8"),
      ).toContain('model = "example-model"');
      const graph = neighborhood(f.store, "file:src/token.ts", 2, 4);
      expect(graph.nodes.length).toBeLessThanOrEqual(4);
      expect(
        graph.edges.every(
          (e) =>
            graph.nodes.some((n) => n.id === e.source) &&
            graph.nodes.some((n) => n.id === e.target),
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
  it("links relative paths from a subdirectory cwd and honors scan exclusions", () => {
    const f = fixtureRepo();
    try {
      expect(
        codeReferences(f.store, "token.ts", f.root, path.join(f.root, "src")),
      ).toEqual(["file:src/token.ts"]);
      f.write(".rexignore", "src/session.ts\n");
      f.write(".env", "SECRET=not-for-indexing");
      fs.symlinkSync(
        path.join(f.root, "src/token.ts"),
        path.join(f.root, "linked.ts"),
      );
      indexCode(f.store);
      expect(f.store.get("file:src/session.ts")?.active).toBe(0);
      expect(f.store.get("file:.env")).toBeUndefined();
      expect(f.store.get("file:linked.ts")).toBeUndefined();
    } finally {
      f.close();
    }
  });
});
