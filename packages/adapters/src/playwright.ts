// Playwright JSON reporter -> CTRF. Fallback for repos that do not run playwright-ctrf-json-reporter.
// Shape: { config, suites: [{ title, file, specs: [{ title, ok, tags, line, id, tests: [{ projectName, status, results: [...] }] }], suites: [...] }], stats }
import {
  CTRF_SPEC_VERSION,
  type CtrfReport,
  type CtrfTest,
  type CtrfAttachment,
  type Mutable,
} from "@quality-sh/tag-schema";
import {
  basename,
  environmentFrom,
  isJson,
  parseJson,
  type Adapter,
  type AdapterInput,
} from "./types.ts";

interface PwAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}
interface PwError {
  message?: string;
  stack?: string;
  snippet?: string;
  location?: { file: string; line: number; column: number };
}
interface PwResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  startTime?: string;
  retry: number;
  error?: PwError;
  errors?: PwError[];
  attachments?: PwAttachment[];
  stdout?: Array<{ text?: string; buffer?: string }>;
  stderr?: Array<{ text?: string; buffer?: string }>;
}
interface PwTest {
  projectName?: string;
  projectId?: string;
  status: "expected" | "unexpected" | "flaky" | "skipped";
  expectedStatus?: string;
  results: PwResult[];
  annotations?: Array<{ type: string; description?: string }>;
}
interface PwSpec {
  title: string;
  ok: boolean;
  tags?: string[];
  line?: number;
  column?: number;
  id?: string;
  file?: string;
  tests: PwTest[];
}
interface PwSuite {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  config?: { version?: string; rootDir?: string };
  suites: PwSuite[];
  stats?: {
    startTime?: string;
    duration?: number;
    expected?: number;
    unexpected?: number;
    flaky?: number;
    skipped?: number;
  };
}

function looksLikePlaywright(o: unknown): o is PwReport {
  return !!o && typeof o === "object" && Array.isArray((o as PwReport).suites) && "config" in o;
}

const mapResultStatus = (s: PwResult["status"]): CtrfTest["status"] =>
  s === "passed"
    ? "passed"
    : s === "skipped"
      ? "skipped"
      : s === "failed" || s === "timedOut"
        ? "failed"
        : "other";

function walk(
  suite: PwSuite,
  trail: string[],
  out: Array<{ spec: PwSpec; trail: string[]; file: string | undefined }>,
) {
  const nextTrail = suite.title ? [...trail, suite.title] : trail;
  for (const spec of suite.specs ?? [])
    out.push({ spec, trail: nextTrail, file: spec.file ?? suite.file });
  for (const child of suite.suites ?? []) walk(child, nextTrail, out);
}

export function convertPlaywright(
  report: PwReport,
  ctx: AdapterInput["context"],
  sourcePath: string,
  htmlReportIndex?: string,
): CtrfReport {
  const specs: Array<{ spec: PwSpec; trail: string[]; file: string | undefined }> = [];
  for (const s of report.suites) walk(s, [], specs);
  const tests: CtrfTest[] = [];
  const reportDir = sourcePath.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";

  for (const { spec, trail, file } of specs) {
    for (const pt of spec.tests) {
      const results = pt.results ?? [];
      const final = results[results.length - 1];
      if (!final) continue;
      const status: CtrfTest["status"] =
        pt.status === "skipped"
          ? "skipped"
          : pt.status === "unexpected"
            ? "failed"
            : mapResultStatus(final.status) === "skipped"
              ? "skipped"
              : "passed";
      const start = final.startTime ? Date.parse(final.startTime) : NaN;
      const attachments: CtrfAttachment[] = (final.attachments ?? [])
        .filter((a) => a.path)
        .map((a) => ({ name: a.name, contentType: a.contentType, path: a.path as string }));
      // suite trail from the JSON reporter is [file title, describe titles...]; the first entry is the file name.
      const head = trail[0];
      const suite: [string, ...string[]] =
        head !== undefined ? [head, ...trail.slice(1)] : [file ?? "root"];
      const err = final.error ?? final.errors?.[0];
      const t: Mutable<CtrfTest> = {
        name: spec.title,
        status,
        duration: Math.round(results.reduce((a, r) => a + r.duration, 0)),
        suite,
        rawStatus: pt.status,
        flaky: pt.status === "flaky",
        retries: Math.max(0, results.length - 1),
        ...(Number.isFinite(start) ? { start, stop: start + Math.round(final.duration) } : {}),
        ...(file ? { filePath: file } : {}),
        ...(spec.line !== undefined ? { line: spec.line } : {}),
        ...(spec.tags?.length ? { tags: spec.tags.map((x) => x.replace(/^@/, "")) } : {}),
        ...(pt.projectName ? { browser: pt.projectName } : {}),
        ...(err?.message ? { message: stripAnsi(err.message).split("\n")[0] } : {}),
        ...(err?.stack ? { trace: stripAnsi(err.stack) } : {}),
        ...(err?.snippet ? { snippet: stripAnsi(err.snippet) } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(spec.id
          ? { extra: { "playwright.specId": spec.id, "playwright.htmlReport": htmlReportIndex } }
          : {}),
      };
      const [firstPrior, ...restPrior] = results.slice(0, -1);
      if (firstPrior) {
        const toAttempt = (r: PwResult, i: number) => {
          const msg = (r.error ?? r.errors?.[0])?.message;
          const line = msg ? stripAnsi(msg).split("\n")[0] : undefined;
          return {
            attempt: i + 1,
            status: mapResultStatus(r.status),
            duration: Math.round(r.duration),
            ...(line ? { message: line } : {}),
          };
        };
        t.retryAttempts = [
          toAttempt(firstPrior, 0),
          ...restPrior.map((r, i) => toAttempt(r, i + 1)),
        ];
      }
      tests.push(t);
    }
  }

  const startMs = report.stats?.startTime
    ? Date.parse(report.stats.startTime)
    : ctx.timestamp
      ? Date.parse(ctx.timestamp)
      : Date.now();
  const durationMs = Math.round(
    report.stats?.duration ?? tests.reduce((a, t) => a + t.duration, 0),
  );
  const count = (s: CtrfTest["status"]) => tests.filter((t) => t.status === s).length;
  const artifacts = [
    {
      kind: "playwright-json",
      name: "Playwright JSON",
      path: sourcePath,
      contentType: "application/json",
    },
  ];
  if (htmlReportIndex)
    artifacts.unshift({
      kind: "playwright-html",
      name: "Playwright HTML report",
      path: htmlReportIndex,
      contentType: "text/html",
    });

  return {
    reportFormat: "CTRF",
    specVersion: CTRF_SPEC_VERSION,
    runId: ctx.runId,
    // The run's time when CI gave one; the report's own start time otherwise.
    timestamp: ctx.timestamp ?? new Date(startMs).toISOString(),
    generatedBy: "tag-adapter-playwright",
    results: {
      tool: {
        name: "playwright",
        ...(report.config?.version ? { version: report.config.version } : {}),
      },
      summary: {
        tests: tests.length,
        passed: count("passed"),
        failed: count("failed"),
        skipped: count("skipped"),
        pending: 0,
        other: count("other"),
        flaky: tests.filter((t) => t.flaky).length,
        start: startMs,
        stop: startMs + durationMs,
        duration: durationMs,
      },
      tests,
      environment: environmentFrom(ctx),
      extra: {
        "tag.artifacts": artifacts,
        ...(reportDir ? { "playwright.reportDir": reportDir } : {}),
      },
    },
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

export function findPlaywrightHtmlIndex(paths: string[]): string | undefined {
  const dirsWithTrace = new Set(
    paths
      .filter((p) => /(^|\/)trace\/index\.html$/.test(p))
      .map((p) => p.replace(/\/?trace\/index\.html$/, "")),
  );
  const direct = paths.find((p) => /(^|\/)playwright-report\/index\.html$/.test(p));
  if (direct) return direct;
  return paths.find(
    (p) => basename(p) === "index.html" && dirsWithTrace.has(p.replace(/\/?index\.html$/, "")),
  );
}

export const playwrightAdapter: Adapter = {
  name: "playwright",
  version: "0.1.0",
  detect: (paths) => paths.some(isJson),
  async parse({ files, context }) {
    const out: CtrfReport[] = [];
    const html = findPlaywrightHtmlIndex(files.map((f) => f.path));
    for (const f of files.filter((f) => isJson(f.path))) {
      const parsed = parseJson(await f.text());
      if (!looksLikePlaywright(parsed)) continue;
      out.push(convertPlaywright(parsed, context, f.path, html));
    }
    return out;
  },
};
