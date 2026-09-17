import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { indexCode } from "../src/code.js";

export function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rex-test-"));
  const write = (name: string, text: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  write(
    "src/session.ts",
    "export function serializeSession(fn: () => string) { return fn(); }\n",
  );
  write(
    "src/token.ts",
    "import { serializeSession } from './session.js';\nexport function refreshToken() { return serializeSession(() => 'token'); }\n",
  );
  write(
    "tests/refresh.test.ts",
    "import { refreshToken } from '../src/token.js';\nexport function testRefresh() { return refreshToken(); }\n",
  );
  write(".gitignore", ".rex/\nhistory/\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const store = new Store(root, { create: true });
  indexCode(store);
  return {
    root,
    store,
    write,
    close: () => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const ts = "2026-01-01T12:00:00.000Z";
export function codexTranscript(
  root: string,
  id = "codex-fixture",
  text = "Fixed the refreshToken() race in src/token.ts using per-session serialization. The regression test in tests/refresh.test.ts now passes.",
) {
  return (
    [
      { type: "session_meta", timestamp: ts, payload: { id, cwd: root } },
      {
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix refresh token race" }],
        },
      },
      {
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "patch1",
          input:
            "*** Begin Patch\n*** Update File: src/token.ts\n@@\n-old\n+new\n*** End Patch",
        },
      },
      {
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "custom_tool_call_output",
          call_id: "patch1",
          output: "Success. Updated src/token.ts",
        },
      },
      {
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "test1",
          arguments: JSON.stringify({
            cmd: "npm test -- tests/refresh.test.ts",
          }),
        },
      },
      {
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "function_call_output",
          call_id: "test1",
          output: "Process exited with code 0\nTests passed",
        },
      },
      {
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
}
export function claudeTranscript(
  root: string,
  text = "Optimistic locking failed because of a Redis TTL race in src/token.ts. The refreshToken() function needs serialization.",
) {
  return (
    [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: root,
        timestamp: ts,
        message: { content: "Investigate the refresh race" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        cwd: root,
        timestamp: ts,
        message: { content: [{ type: "text", text }] },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
}
