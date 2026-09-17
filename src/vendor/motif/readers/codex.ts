// SPDX-License-Identifier: Apache-2.0
// Derived from Motif; modified for Motif Solo. Original attribution: NOTICE.
/**
 * Codex CLI session reader. Rollouts live at
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl, one JSON line
 * per event: {timestamp, ordinal?, type, payload}. The model-visible history
 * is the response_item lines; event_msg/turn_context/world_state are
 * runtime telemetry. Format pinned by fixtures/codex/ and the handoff
 * writer, which emits this same shape.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MotifMessage, MotifSession } from "../schema.js";
import { motifSessionId } from "../schema.js";

export function defaultCodexDir(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export interface CodexSessionFileInfo {
  path: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
}

export function discoverCodexSessions(
  codexDir = defaultCodexDir(),
): CodexSessionFileInfo[] {
  const roots = ["sessions", "archived_sessions"].map((d) =>
    path.join(codexDir, d),
  );
  const out: CodexSessionFileInfo[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        const m = e.name.match(
          /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+?)(?:_[0-9a-f-]+)?\.jsonl$/,
        );
        if (!m) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        out.push({
          path: full,
          sessionId: m[1]!,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return out;
}

/**
 * A rollout Motif itself wrote (a handoff) that Codex has not touched yet is
 * a copy of a session we already have, syncing it back would duplicate the
 * conversation. Codex appends turn_context lines the moment it resumes, so
 * "originator motif AND no turn_context" identifies the dormant copies.
 */
export function isDormantHandoff(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const firstLine = raw.slice(0, raw.indexOf("\n"));
    if (!firstLine.includes('"originator":"motif"')) return false;
    return !raw.includes('"type":"turn_context"');
  } catch {
    return false;
  }
}

/** Injected context blocks (environment, skills, instructions) are not conversation. */
function isSyntheticUserText(text: string): boolean {
  return /^\s*<\/?[a-z_]+[_a-z]*>/.test(text);
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (b && typeof b === "object") {
        const block = b as Record<string, unknown>;
        if (typeof block.text === "string") return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function readCodexSession(
  filePath: string,
  snapshot?: string,
): MotifSession {
  const raw = snapshot ?? fs.readFileSync(filePath, "utf8");
  const base = path.basename(filePath);
  // session_meta.id is authoritative; the filename is a fallback for truncated files
  let sessionId =
    base.match(
      /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+?)(?:_[0-9a-f-]+)?\.jsonl$/,
    )?.[1] ?? base.replace(/\.jsonl$/, "");

  const messages: MotifMessage[] = [];
  let parseErrors = 0;
  let projectPath = "";
  let gitBranch: string | undefined;
  let gitCommit: string | undefined;
  let parentSessionId: string | undefined;
  let handoffFrom: string | undefined;
  let toolVersion: string | undefined;
  let model: string | undefined;
  let firstPrompt: string | undefined;
  let createdAt = "";
  let updatedAt = "";
  let ordinalFallback = 0;

  let sourceLine = 0;
  for (const lineText of raw.split("\n")) {
    sourceLine++;
    const messageStart = messages.length;
    if (!lineText.trim()) continue;
    let line: {
      timestamp?: string;
      ordinal?: number;
      type?: string;
      payload?: Record<string, unknown>;
    };
    try {
      line = JSON.parse(lineText);
      if (!line || typeof line !== "object" || Array.isArray(line)) {
        parseErrors++;
        continue;
      }
    } catch {
      parseErrors++;
      continue;
    }
    const ts = line.timestamp ?? "";
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = ts;
    }
    const p = line.payload ?? {};
    // ordinal-derived ids live in the `o<n>` namespace; a fallback for an
    // ordinal-less line must use a DIFFERENT namespace, or it can collide with a
    // real `o<n>` and the server's INSERT OR IGNORE would silently drop a message
    const id =
      line.ordinal !== undefined ? `o${line.ordinal}` : `f${ordinalFallback++}`;

    switch (line.type) {
      case "session_meta": {
        if (typeof p.id === "string") sessionId = p.id;
        if (typeof p.cwd === "string") projectPath = p.cwd;
        if (typeof p.cli_version === "string") toolVersion = p.cli_version;
        const git = p.git as
          { branch?: string; commit_hash?: string } | undefined;
        gitCommit = git?.commit_hash;
        const origin = p.source as any;
        const parent = origin?.subagent?.thread_spawn?.parent_thread_id;
        if (typeof parent === "string") parentSessionId = `codex:${parent}`;
        if (typeof git?.branch === "string") gitBranch = git.branch;
        break;
      }
      case "turn_context":
        if (typeof p.model === "string") model = p.model;
        break;
      case "response_item": {
        switch (p.type) {
          case "message": {
            const text = contentText(p.content);
            if (!text) break;
            if (p.role === "user") {
              if (isSyntheticUserText(text)) break;
              const handoff = text.match(
                /\[Handed off from (Claude Code|Codex) session ([\w-]+)/,
              );
              if (handoff)
                handoffFrom = `${handoff[1] === "Claude Code" ? "claude-code" : "codex"}:${handoff[2]}`;
              // provenance markers from prior handoffs make poor titles
              if (
                !firstPrompt &&
                !text.startsWith("[Handed off") &&
                !text.startsWith("[Condensed history")
              ) {
                firstPrompt = text;
              }
              messages.push({ id, role: "user", timestamp: ts, text });
            } else if (p.role === "assistant") {
              // Some imported histories encode inert tool events as assistant text.
              // They are evidence of tool activity, not claims by the assistant.
              const bridgeCall = text.match(
                /^\[external_agent_tool_call: ([^\]]+)\]\n([\s\S]*?)\n\[\/external_agent_tool_call\]$/,
              );
              const bridgeResult = text.match(
                /^\[external_agent_tool_result(: error)?\]\n([\s\S]*?)\n\[\/external_agent_tool_result\]$/,
              );
              if (bridgeCall)
                messages.push({
                  id,
                  role: "tool_call",
                  timestamp: ts,
                  toolName: bridgeCall[1],
                  toolInput: { bridged: true, text: bridgeCall[2] },
                });
              else if (bridgeResult)
                messages.push({
                  id,
                  role: "tool_result",
                  timestamp: ts,
                  text: bridgeResult[2],
                  isError: !!bridgeResult[1],
                });
              else
                messages.push({
                  id,
                  role: p.channel === "analysis" ? "reasoning" : "assistant",
                  timestamp: ts,
                  text,
                });
            }
            // developer-role items are injected instructions, not conversation
            break;
          }
          case "custom_tool_call":
          case "function_call": {
            let input: unknown = p.arguments ?? p.input;
            if (typeof p.arguments === "string") {
              try {
                input = JSON.parse(p.arguments);
              } catch {
                /* keep the raw string */
              }
            }
            messages.push({
              id,
              role: "tool_call",
              timestamp: ts,
              toolName: typeof p.name === "string" ? p.name : "unknown",
              toolCallId: typeof p.call_id === "string" ? p.call_id : id,
              toolInput: input,
            });
            break;
          }
          case "custom_tool_call_output":
          case "function_call_output": {
            const output = p.output;
            messages.push({
              id,
              role: "tool_result",
              timestamp: ts,
              toolCallId: typeof p.call_id === "string" ? p.call_id : undefined,
              text:
                typeof output === "string"
                  ? output
                  : contentText(output) || JSON.stringify(output ?? ""),
            });
            break;
          }
          case "reasoning":
            // encrypted / summarized reasoning, no portable text to keep
            break;
          default:
            break;
        }
        break;
      }
      default:
        break; // event_msg, world_state, compacted, runtime telemetry
    }
    for (let i = messageStart; i < messages.length; i++)
      messages[i]!.sourceLine = sourceLine;
  }

  return {
    id: motifSessionId("codex", sessionId),
    source: "codex",
    sourceSessionId: sessionId,
    sourcePath: filePath,
    projectPath,
    gitBranch,
    gitCommit,
    parentSessionId,
    handoffFrom,
    title: firstPrompt
      ? firstPrompt.replace(/\s+/g, " ").trim().slice(0, 120)
      : undefined,
    createdAt,
    updatedAt,
    toolVersion,
    messages,
    filesTouched: [],
    meta: {
      subagentCount: 0,
      branchCount: 0,
      parseErrors,
      model,
      sourceBytes: Buffer.byteLength(raw),
    },
  };
}
