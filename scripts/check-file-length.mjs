// Every source file stays under LIMIT lines. Files already over it are listed in the
// baseline with their line count and may only shrink; `--write-baseline` records the
// current offenders after a split. Usage: bun scripts/check-file-length.mjs [--write-baseline]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const LIMIT = 500;
const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE = join(ROOT, "scripts", "file-length-baseline.json");
const ROOTS = ["packages", "scripts"];
const SKIP = new Set(["node_modules", "dist", "fixtures", "fixtures-scan", ".data"]);
const EXT = /\.(ts|tsx|mjs|js)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith(".data")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXT.test(entry)) yield full;
  }
}

const lines = (file) => readFileSync(file, "utf8").split("\n").length - 1;

const counts = new Map();
for (const root of ROOTS)
  for (const file of walk(join(ROOT, root))) counts.set(relative(ROOT, file), lines(file));

const over = [...counts].filter(([, n]) => n > LIMIT).sort((a, b) => b[1] - a[1]);

if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(over), null, 2)}\n`);
  console.log(`baseline: ${over.length} files over ${LIMIT} lines`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const failures = over.filter(([file, n]) => !(file in baseline) || n > baseline[file]);
const fixed = Object.keys(baseline).filter((file) => (counts.get(file) ?? 0) <= LIMIT);

for (const [file, n] of failures) {
  const allowed =
    file in baseline
      ? `grew past its baseline of ${baseline[file]}`
      : `is over the ${LIMIT}-line limit`;
  console.error(`${file}: ${n} lines, ${allowed}`);
}
for (const file of fixed)
  console.error(`${file} is under the limit now: drop it from the baseline`);

if (failures.length || fixed.length) process.exit(1);
console.log(
  `file length: ${counts.size} files, ${over.length} still over ${LIMIT} within their baseline`,
);
