// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectFiles } from "./privacy-check.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "motif-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, cwd = temp) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: path.join(os.tmpdir(), "motif-package-cache"),
    },
  });
try {
  run(npm, ["run", "build"], process.cwd());
  const packed = JSON.parse(
    run(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
      process.cwd(),
    ),
  )[0];
  for (const { path: name } of packed.files) {
    if (
      !/^(?:dist\/[^/]+\.js|docs\/[a-z-]+\.md|package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md)$/.test(
        name,
      )
    )
      throw new Error(`Unexpected package file: ${name}`);
  }
  run("tar", ["-xzf", path.join(temp, packed.filename), "-C", temp]);
  inspectFiles(
    path.join(temp, "package"),
    packed.files.map((f) => f.path),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(temp, "package", "package.json"), "utf8"),
  );
  if (
    manifest.name !== "motif-solo" ||
    manifest.license !== "Apache-2.0" ||
    manifest.bin["motif-solo"] !== "dist/cli.js"
  )
    throw new Error("Invalid public package metadata");
  fs.writeFileSync(path.join(temp, "package.json"), '{"private":true}\n');
  run(npm, [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    path.join(temp, packed.filename),
  ]);
  const cli = path.join(temp, "node_modules", "motif-solo", "dist", "cli.js");
  if (run(process.execPath, [cli, "--version"]).trim() !== manifest.version)
    throw new Error("CLI version does not match package");
  const repo = path.join(temp, "demo");
  const empty = path.join(temp, "empty");
  fs.mkdirSync(repo);
  fs.mkdirSync(empty);
  fs.writeFileSync(
    path.join(repo, "token.ts"),
    'export function refreshToken() { return "demo"; }\n',
  );
  run(process.execPath, [
    cli,
    "init",
    "--repo",
    repo,
    "--codex-dir",
    empty,
    "--claude-dir",
    empty,
  ]);
  const context = JSON.parse(
    run(process.execPath, [cli, "context", "refreshToken", "--repo", repo]),
  );
  if (!context.code.some((c) => c.symbol === "refreshToken"))
    throw new Error("Installed CLI failed to retrieve code");
  console.log(
    `Package verified: ${packed.files.length} allowed files, fresh production install, CLI init and retrieval.`,
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
