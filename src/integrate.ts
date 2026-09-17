// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { Store } from "./store.js";
import {
  assertLocalPath,
  canonical,
  git,
  hash,
  secureDirectory,
  writePrivate,
} from "./util.js";

export function ignoreLocalFiles(store: Store, files = [".rex/"]) {
  const dir = git(store.root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!dir) return;
  const exclude = path.join(dir, "info", "exclude");
  assertLocalPath(canonical(dir), exclude);
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude)
    ? fs.readFileSync(exclude, "utf8")
    : "";
  const missing = files.filter((f) => !current.split("\n").includes(`/${f}`));
  if (missing.length)
    writePrivate(
      exclude,
      `${current}\n# Motif Solo local data\n${missing.map((f) => `/${f}`).join("\n")}\n`,
    );
}
export function integrate(store: Store, entry: string, print = false) {
  const command = process.execPath;
  const args = [path.resolve(entry), "mcp", "--repo", store.root];
  const claudeFile = path.join(store.root, ".mcp.json");
  const codexFile = path.join(store.root, ".codex", "config.toml");
  const outputs = {
    claude: { path: claudeFile, command, args },
    codex: { path: codexFile, command, args },
    note: "Project-scoped MCP configuration. Restart the agents; their usual project trust/MCP approval applies.",
  };
  if (print) return outputs;
  for (const file of [claudeFile, codexFile]) assertLocalPath(store.root, file);
  const claudeRaw = fs.existsSync(claudeFile)
    ? fs.readFileSync(claudeFile, "utf8")
    : "{}";
  const codexRaw = fs.existsSync(codexFile)
    ? fs.readFileSync(codexFile, "utf8")
    : "";
  // Parse both before touching either. Preserve unknown settings and other servers.
  const claude = JSON.parse(claudeRaw);
  const codex = TOML.parse(codexRaw) as any;
  if (
    !claude ||
    typeof claude !== "object" ||
    Array.isArray(claude) ||
    (claude.mcpServers !== undefined &&
      (!claude.mcpServers ||
        typeof claude.mcpServers !== "object" ||
        Array.isArray(claude.mcpServers)))
  )
    throw new Error("Expected a Claude MCP configuration object");
  const desired = { command, args };
  if (
    claude.mcpServers?.rex &&
    JSON.stringify(claude.mcpServers.rex) !== JSON.stringify(desired)
  )
    throw new Error(
      "A different Claude MCP server named rex already exists. Rename it or use --print.",
    );
  if (
    codex.mcp_servers?.rex &&
    JSON.stringify(codex.mcp_servers.rex) !== JSON.stringify(desired)
  )
    throw new Error(
      "A different Codex MCP server named rex already exists. Rename it or use --print.",
    );
  const backups = path.join(store.dir, "config-backups");
  assertLocalPath(store.root, backups);
  secureDirectory(backups);
  for (const [file, raw] of [
    [claudeFile, claudeRaw],
    [codexFile, codexRaw],
  ])
    if (fs.existsSync(file)) {
      const backup = path.join(
        backups,
        `${path.basename(file)}-${hash(raw).slice(0, 12)}`,
      );
      assertLocalPath(store.root, backup);
      if (!fs.existsSync(backup)) writePrivate(backup, raw);
    }
  claude.mcpServers = { ...(claude.mcpServers ?? {}), rex: desired };
  fs.mkdirSync(path.dirname(codexFile), { recursive: true, mode: 0o700 });
  writePrivate(claudeFile, `${JSON.stringify(claude, null, 2)}\n`);
  if (!codex.mcp_servers?.rex)
    writePrivate(
      codexFile,
      `${codexRaw}\n[mcp_servers.rex]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`,
    );
  ignoreLocalFiles(store, [".rex/", ".mcp.json", ".codex/config.toml"]);
  return outputs;
}
