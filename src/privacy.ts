// SPDX-License-Identifier: Apache-2.0
// Adapted from Motif's default redaction patterns (Apache-2.0); see NOTICE.
const patterns = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /mm_[A-Za-z0-9_-]{24,}/g,
  /((?:api[_-]?key|password|secret|(?:access|refresh|auth)[_-]?token)["']?\s*[=:]\s*["']?)[^\s"',;}{]+/gi,
  /((?:authorization|proxy-authorization)["']?\s*[=:]\s*["']?(?:(?:Bearer|Basic)\s+)?)[^\s"',;}{]+/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
];
export function redact(text: string): string {
  for (const re of patterns)
    text = text.replace(
      re,
      re.source.startsWith("(") || re.source.startsWith("\\b(")
        ? "$1[REDACTED]"
        : "[REDACTED]",
    );
  return text;
}
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(?:api[_-]?key|password|passwd|secret|client[_-]?secret|(?:access|refresh|auth)[_-]?token|authorization|proxy-authorization|cookie|set-cookie|private[_-]?key)$/i.test(
          k,
        )
          ? "[REDACTED]"
          : redactValue(v),
      ]),
    ) as T;
  return value;
}
