// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "motif-demo-")),
);
const cli = path.resolve("dist/cli.js");
const timestamp = "2026-01-01T12:00:00Z";
const write = (name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const jsonl = (values) =>
  values.map((x) => JSON.stringify(x)).join("\n") + "\n";
try {
  write(
    "src/session.ts",
    "export function serializeSession(fn: () => string) { return fn(); }\n",
  );
  write(
    "src/token.ts",
    'import { serializeSession } from "./session.js";\nexport function refreshToken() { return serializeSession(() => "demo"); }\n',
  );
  write(".rexignore", "history/\n");
  write(
    "history/codex/sessions/2026/01/01/rollout-2026-01-01T12-00-00-00000000-0000-0000-0000-000000000001.jsonl",
    jsonl([
      {
        type: "session_meta",
        timestamp,
        payload: { id: "synthetic-codex", cwd: root },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix refresh token race" }],
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Fixed the refreshToken() race in src/token.ts using per-session serialization with serializeSession().",
            },
          ],
        },
      },
    ]),
  );
  write(
    "history/claude/projects/demo/synthetic-claude.jsonl",
    jsonl([
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp,
        cwd: root,
        message: { content: "Investigate refresh token race" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp,
        cwd: root,
        message: {
          content: [
            {
              type: "text",
              text: "Optimistic locking failed because of a Redis TTL race in src/token.ts. The refreshToken() function needs serialization.",
            },
          ],
        },
      },
    ]),
  );
  const run = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args, "--repo", root], {
        encoding: "utf8",
      }),
    );
  const result = run([
    "init",
    "--codex-dir",
    path.join(root, "history/codex"),
    "--claude-dir",
    path.join(root, "history/claude"),
  ]);
  if (result.sessions.imported !== 2)
    throw new Error("Expected both synthetic sessions");
  const packet = run(["context", "refreshToken race"]);
  if (packet.experience.length < 2)
    throw new Error("Expected cross-agent findings");
  console.log(
    "Synthetic demonstration — no personal history and no performance claim.",
  );
  console.log(JSON.stringify(packet, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
