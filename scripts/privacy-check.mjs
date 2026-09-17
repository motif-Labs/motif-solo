// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A publishing guard, not an exhaustive secret detector. Gitleaks is run separately.
const privatePath =
  /\/(?:Users|home)\/[A-Za-z0-9_. -]+|[A-Z]:\\Users\\[A-Za-z0-9_. -]+/g;
const credential =
  /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const email = /\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/gi;
const forbidden =
  /(?:^|\/)(?:\.rex|\.local|node_modules|\.codex|\.claude|benchmark-results)(?:\/|$)|(?:^|\/)(?:\.mcp\.json|\.npmrc|\.env(?:\..*)?)$|\.(?:db|sqlite|pem|key|p12|pfx|tgz)$|\.jsonl\.gz$/;

export function inspectFiles(root, files) {
  const errors = [];
  for (const name of files) {
    if (forbidden.test(name)) {
      errors.push(`${name}: private/generated artifact`);
      continue;
    }
    if (name.endsWith(".jsonl") && !name.startsWith("tests/fixtures/")) {
      errors.push(`${name}: session data outside synthetic fixtures`);
    }
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) {
      errors.push(`${name}: non-regular source entry`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    if (credential.test(text))
      errors.push(`${name}: credential-shaped content`);
    // Omit matching content from logs: finding a secret must not publish it again.
    for (const match of text.matchAll(privatePath)) {
      if (!/^\/(?:Users|home)\/(?:example|demo|user)(?:$|\/)/.test(match[0]))
        errors.push(`${name}: personal absolute path`);
    }
    for (const match of text.matchAll(email)) {
      if (
        !/@(?:example\.(?:com|invalid)|users\.noreply\.github\.com|apache\.org|motif\.invalid)$/i.test(
          match[0],
        )
      )
        errors.push(`${name}: review email address`);
    }
  }
  if (errors.length) throw new Error([...new Set(errors)].join("\n"));
  return files.length;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const files = [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean),
    ),
  ];
  console.log(
    `Privacy guard: ${inspectFiles(process.cwd(), files)} source files checked.`,
  );
}
