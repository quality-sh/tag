// What a repository runs and already uploads, decided from its tree, its workflow texts and
// artifact samples. Pure: the caller fetches paths and texts; this module only reads them.

export type ScanClassification = "reporting" | "needs-change" | "unsupported" | "no-tests";

export type Runner =
  | "vitest"
  | "jest"
  | "bun test"
  | "playwright"
  | "mocha"
  | "cargo test"
  | "nextest"
  | "pytest"
  | "go test"
  | "deepeval";

export interface RunnerFinding {
  readonly runner: Runner;
  /** The workflow job that runs it, when a workflow does. */
  readonly job: string | null;
  /** The command line that runs it, when a workflow does. */
  readonly command: string | null;
}

export interface UnreadArtifact {
  readonly name: string;
  readonly format: "mocha-json" | "tap" | "go-test-json" | "unknown";
}

/** Config files whose presence alone says a runner is set up. */
const CONFIG_FILES: ReadonlyArray<readonly [Runner, (base: string) => boolean]> = [
  ["vitest", (b) => /^vitest\.(config|workspace)\./.test(b)],
  ["jest", (b) => /^jest\.config\.(js|cjs|mjs|ts|cts|mts|json)$/.test(b)],
  ["playwright", (b) => /^playwright\.config\.(ts|mts|js|mjs|cts|cjs)$/.test(b)],
  ["mocha", (b) => b.startsWith(".mocharc")],
  ["cargo test", (b) => b === "Cargo.toml"],
  ["pytest", (b) => b === "pytest.ini" || b === "pyproject.toml"],
  ["go test", (b) => b === "go.mod"],
];

/** Commands a `run:` step may hold, most specific first so `cargo nextest` wins over the rest. */
export const RUN_COMMANDS: ReadonlyArray<readonly [Runner, RegExp]> = [
  ["nextest", /\bcargo\s+nextest\b/],
  ["cargo test", /\bcargo\s+test\b/],
  ["go test", /\bgo\s+test\b/],
  ["pytest", /\bpytest\b/],
  ["vitest", /\bvitest\b/],
  ["playwright", /\bplaywright\b/],
  ["jest", /\bjest\b/],
  ["bun test", /\bbun\s+test\b/],
  ["mocha", /\bmocha\b/],
  ["deepeval", /\bdeepeval\b/],
];

const isWorkflow = (path: string) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

const indentOf = (line: string) => line.length - line.trimStart().length;

const BLOCK = /^(?:\||>)[+-]?$|^$/;

/**
 * Each job's commands from one workflow's text. Workflows need no YAML reader here: job keys
 * sit at two spaces under `jobs:`, and a step's command follows `run:` on the same line or,
 * for a block scalar, on the deeper lines that follow it.
 */
export const jobCommands = (
  text: string,
): ReadonlyArray<readonly [job: string, command: string]> => {
  const out: Array<readonly [string, string]> = [];
  let inJobs = false;
  let job: string | null = null;
  let blockIndent = -1;
  let block: string[] | null = null;
  const flush = () => {
    if (job !== null && block !== null && block.length > 0) out.push([job, block.join("\n")]);
    block = null;
    blockIndent = -1;
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (blockIndent >= 0) {
      if (indent > blockIndent) {
        block?.push(line.trim());
        continue;
      }
      flush();
    }
    if (indent === 0) {
      inJobs = /^jobs:\s*(?:#.*)?$/.test(line);
      job = null;
      continue;
    }
    if (!inJobs) continue;
    if (indent === 2) {
      const m = /^([^#:\s][^:]*):\s*(?:#.*)?$/.exec(line.slice(2));
      if (m) {
        flush();
        job = (m[1] ?? "").trim();
      }
      continue;
    }
    const run = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run && job !== null) {
      const rest = (run[1] ?? "").trim();
      if (BLOCK.test(rest)) {
        flush();
        block = [];
        blockIndent = indent;
      } else {
        out.push([job, rest]);
      }
    }
  }
  flush();
  return out;
};

/**
 * Every runner the tree and workflows show. A workflow that runs one names its job and
 * command; a config file alone names the runner with nothing else.
 */
export const detectRunners: (input: {
  paths: ReadonlyArray<string>;
  files: ReadonlyArray<{ path: string; text: string }>;
}) => ReadonlyArray<RunnerFinding> = ({ paths, files }) => {
  const found = new Map<Runner, RunnerFinding>();
  const add = (f: RunnerFinding) => {
    if (!found.has(f.runner)) found.set(f.runner, f);
  };
  for (const file of files) {
    if (!isWorkflow(file.path)) continue;
    for (const [job, command] of jobCommands(file.text))
      for (const [runner, re] of RUN_COMMANDS) if (re.test(command)) add({ runner, job, command });
  }
  for (const [runner, matches] of CONFIG_FILES)
    if (!found.has(runner) && paths.some((p) => matches(p.split("/").at(-1) ?? p)))
      add({ runner, job: null, command: null });
  return [...found.values()].sort((a, b) => a.runner.localeCompare(b.runner));
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Mocha's JSON reporter: a `stats` object beside its `tests`, `passes` or `failures` lists. */
const looksLikeMochaJson = (text: string): boolean => {
  const t = text.trimStart();
  if (!t.startsWith("{")) return false;
  const body = parsedJson(t);
  if (typeof body !== "object" || body === null) return false;
  const stats = (body as Record<string, unknown>)["stats"];
  const list = (k: string) => Array.isArray((body as Record<string, unknown>)[k]);
  return (
    typeof stats === "object" &&
    stats !== null &&
    (list("tests") || list("passes") || list("failures"))
  );
};

/** TAP announces its version; a plan line beside a `not ok` names the format without one. */
const looksLikeTap = (text: string): boolean =>
  /^\s*TAP version\b/m.test(text) || (/^\s*1\.\.\d+/m.test(text) && /^\s*not ok\b/m.test(text));

/** go test -json is one record per line, each carrying an `Action`. */
const looksLikeGoTestJson = (text: string): boolean => {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    const body = parsedJson(t);
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>)["Action"] === "string"
    )
      return true;
  }
  return false;
};

/**
 * What an artifact sample holds that the adapters did not read. A recognized format names the
 * unread test output; text in no known shape is `unknown`; nothing to read is `null`.
 */
export const sniffSample: (
  files: ReadonlyArray<{ path: string; text: string }>,
) => UnreadArtifact["format"] | null = (files) => {
  let sawText = false;
  for (const f of files) {
    if (f.text.length === 0) continue;
    sawText = true;
    if (looksLikeMochaJson(f.text)) return "mocha-json";
    if (looksLikeTap(f.text)) return "tap";
    if (looksLikeGoTestJson(f.text)) return "go-test-json";
  }
  return sawText ? "unknown" : null;
};

/**
 * One classification for a repository. Reports win: the repository already produces what TAG
 * reads. Then unread artifacts: the output exists, so the fix is an adapter, not a CI change.
 * Then runners: tests run, but no report reaches TAG.
 */
export const classifyRepository: (input: {
  reporting: ReadonlyArray<string>;
  unread: ReadonlyArray<UnreadArtifact>;
  runners: ReadonlyArray<RunnerFinding>;
}) => ScanClassification = (input) => {
  if (input.reporting.length > 0) return "reporting";
  if (input.unread.length > 0) return "unsupported";
  if (input.runners.length > 0) return "needs-change";
  return "no-tests";
};
