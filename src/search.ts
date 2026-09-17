// SPDX-License-Identifier: Apache-2.0
// Query and excerpt helpers adapted from Motif retrieval.ts. See NOTICE.
const STOP = new Set(
  "the a an and or but is are was were be been to of in on for with what why how when where which who did do does we i you it this that fix please code change help need want".split(
    " ",
  ),
);
export function queryTerms(query: string): string[] {
  const identifiers = (query.match(/\b\w*[a-z][A-Z]\w*\b/g) ?? []).map((s) =>
    s.toLowerCase(),
  );
  return [
    ...new Set([
      ...identifiers,
      ...query
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_/.-]+/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !STOP.has(t)),
    ]),
  ].slice(0, 30);
}
export const ftsOrQuery = (terms: string[]) =>
  terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
export function windowAround(
  text: string,
  terms: string[],
  width: number,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= width) return trimmed;
  const lower = trimmed.toLowerCase();
  const indices = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = indices.length ? Math.min(...indices) : 0;
  const start = Math.max(0, at - Math.floor(width * 0.35));
  return `${start ? "…" : ""}${trimmed.slice(start, start + width)}${start + width < trimmed.length ? "…" : ""}`;
}
