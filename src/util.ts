// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const hash = (value: string | Buffer) =>
  crypto.createHash("sha256").update(value).digest("hex");
export const slash = (value: string) => value.replace(/\\/g, "/");
export function canonical(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
export function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return undefined;
  }
}
export function repoRoot(root: string): string {
  return canonical(
    git(canonical(root), ["rev-parse", "--show-toplevel"]) ?? root,
  );
}
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)
  );
}
export function relativeFile(
  root: string,
  value: string,
  sessionRoot = root,
): string | undefined {
  const clean = value
    .trim()
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/:\d+(?::\d+)?$/, "");
  const base = path.isAbsolute(clean)
    ? clean
    : path.resolve(sessionRoot, clean);
  if (!within(sessionRoot, base)) return undefined;
  const rel = slash(path.relative(sessionRoot, base));
  if (!rel || rel.startsWith(".rex/") || rel.startsWith(".git/"))
    return undefined;
  if (!within(root, canonical(path.resolve(root, rel)))) return undefined;
  return rel;
}
export function secureDirectory(dir: string): void {
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("Refusing a symbolic-link data directory");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Refuse repository-controlled links before reading or writing local state. */
export function assertLocalPath(root: string, target: string): void {
  root = path.resolve(root);
  target = path.resolve(target);
  if (!within(root, target)) throw new Error("Path escapes its local scope");
  let current = root;
  for (const part of ["", ...path.relative(root, target).split(path.sep)]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink > 1))
      throw new Error("Refusing a symbolic or hard link in a local data path");
    if (stat && !stat.isDirectory() && !stat.isFile())
      throw new Error("Refusing a non-regular local data path");
  }
}

/** Atomic replacement; never truncate a link target or retain permissive modes. */
export function writePrivate(file: string, value: string | Buffer): void {
  assertLocalPath(path.dirname(file), file);
  const temp = path.join(
    path.dirname(file),
    `.motif-${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
export function readRegular(
  file: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Expected a regular file within the size limit");
    const data = fs.readFileSync(fd);
    if (data.length > maxBytes) throw new Error("File exceeded the size limit");
    return data;
  } finally {
    fs.closeSync(fd);
  }
}
