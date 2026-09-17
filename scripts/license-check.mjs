// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const allowed = new Set([
  "Apache-2.0",
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "(MIT OR WTFPL)",
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
]);
let count = 0;
for (const [name, info] of Object.entries(lock.packages)) {
  if (!name || info.dev) continue;
  if (!allowed.has(info.license))
    throw new Error(
      `Review runtime dependency license: ${name}: ${info.license ?? "missing"}`,
    );
  count++;
}
console.log(
  `License metadata checked for ${count} locked runtime packages. Preserve dependency license files when redistributing.`,
);
