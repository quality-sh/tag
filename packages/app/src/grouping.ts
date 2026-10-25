// Groupings: the pure model behind the home page. A query string of filters,
// a field to group runs by, and the rows that come out. Shared by the server
// (which runs it over the index) and the web app (which parses and formats the
// query for the search bar). No I/O here.
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Fields and the filter grammar

export const FIELDS = [
  "org",
  "repo",
  "branch",
  "commit",
  "tool",
  "workflow",
  "environment",
  "tag",
  "release",
  "pull_request",
  "day",
  "failed",
  "passed",
  "flaky",
  "tests",
  "text",
] as const;
export type Field = (typeof FIELDS)[number];

const ALIASES: Record<string, Field> = {
  env: "environment",
  pr: "pull_request",
  tags: "tag",
  tool: "tool",
  tools: "tool",
  repository: "repo",
  owner: "org",
  sha: "commit",
};

export const FIELD_INFO: Record<
  Field,
  { readonly label: string; readonly kind: "enum" | "number" | "text"; readonly from: string }
> = {
  org: { label: "org", kind: "enum", from: "the run" },
  repo: { label: "repo", kind: "enum", from: "the run" },
  branch: { label: "branch", kind: "enum", from: "the run" },
  commit: { label: "commit", kind: "text", from: "the run" },
  tool: { label: "tool", kind: "enum", from: "the report" },
  workflow: { label: "workflow", kind: "enum", from: "the run" },
  environment: { label: "environment", kind: "enum", from: "the report" },
  tag: { label: "tag", kind: "enum", from: "the report" },
  release: { label: "release", kind: "enum", from: "GitHub" },
  pull_request: { label: "pull request", kind: "enum", from: "GitHub" },
  day: { label: "day", kind: "enum", from: "the run" },
  failed: { label: "failed", kind: "number", from: "the report" },
  passed: { label: "passed", kind: "number", from: "the report" },
  flaky: { label: "flaky", kind: "number", from: "the report" },
  tests: { label: "tests", kind: "number", from: "the report" },
  text: { label: "text", kind: "text", from: "anywhere" },
};

export const isField = (s: string): s is Field => (FIELDS as ReadonlyArray<string>).includes(s);
export const fieldOf = (s: string): Field | undefined => {
  const k = s.toLowerCase();
  return isField(k) ? k : ALIASES[k];
};

export type Op = "is" | "not" | "in" | "gt" | "lt" | "contains";

export interface Filter {
  readonly field: Field;
  readonly op: Op;
  readonly value: string;
  /** For `in`: the alternatives. */
  readonly values?: ReadonlyArray<string> | undefined;
}

const tokenize = (q: string): string[] => {
  const out: string[] = [];
  const re = /(-?[a-z_]+:)?("([^"]*)"|'([^']*)'|[^\s]+)|"([^"]*)"|'([^']*)'/gi;
  for (const m of q.matchAll(re)) {
    const prefix = m[1] ?? "";
    const value = m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[2] ?? "";
    if (prefix || value) out.push(prefix + value);
  }
  return out;
};

/** `repo:acme/widgets failed:>0 -tag:slow env:staging,production some text` */
export function parseQuery(q: string): Filter[] {
  const filters: Filter[] = [];
  const text: string[] = [];
  for (const tok of tokenize(q)) {
    const m = /^(-?)([a-z_]+):(.*)$/i.exec(tok);
    if (!m) {
      text.push(tok);
      continue;
    }
    const neg = m[1] === "-";
    const field = fieldOf(m[2] ?? "");
    const raw = m[3] ?? "";
    if (!field || raw === "") {
      text.push(tok);
      continue;
    }
    if (
      !neg &&
      (raw.startsWith(">") || raw.startsWith("<")) &&
      FIELD_INFO[field].kind === "number"
    ) {
      filters.push({ field, op: raw.startsWith(">") ? "gt" : "lt", value: raw.slice(1) });
      continue;
    }
    if (!neg && raw.includes(",")) {
      const values = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      filters.push({ field, op: "in", value: raw, values });
      continue;
    }
    filters.push({ field, op: neg ? "not" : field === "commit" ? "contains" : "is", value: raw });
  }
  if (text.length) filters.push({ field: "text", op: "contains", value: text.join(" ") });
  return filters;
}

const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

export function formatFilter(f: Filter): string {
  if (f.field === "text") return quote(f.value);
  switch (f.op) {
    case "not":
      return `-${f.field}:${quote(f.value)}`;
    case "gt":
      return `${f.field}:>${f.value}`;
    case "lt":
      return `${f.field}:<${f.value}`;
    default:
      return `${f.field}:${quote(f.value)}`;
  }
}

export const formatQuery = (filters: ReadonlyArray<Filter>) => filters.map(formatFilter).join(" ");

/** The chip text: `repo: acme/widgets`, `failed: > 0`, `not tag: slow`. */
export function chipOf(f: Filter): { readonly field: string; readonly value: string } {
  const label = FIELD_INFO[f.field].label;
  switch (f.op) {
    case "not":
      return { field: `not ${label}`, value: f.value };
    case "gt":
      return { field: label, value: `> ${f.value}` };
    case "lt":
      return { field: label, value: `< ${f.value}` };
    case "in":
      return { field: label, value: (f.values ?? []).join(", ") };
    case "contains":
      return f.field === "text"
        ? { field: "text", value: f.value }
        : { field: label, value: `${f.value}…` };
    default:
      return { field: label, value: f.value };
  }
}

// ---------------------------------------------------------------------------
// Group by

export const GROUP_BYS = [
  "release",
  "branch",
  "pull_request",
  "environment",
  "tag",
  "tool",
  "workflow",
  "repo",
  "day",
  "run",
] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const isGroupBy = (s: string): s is GroupBy =>
  (GROUP_BYS as ReadonlyArray<string>).includes(s);

export const GROUP_BY_INFO: Record<
  GroupBy,
  { readonly label: string; readonly one: string; readonly lede: string }
> = {
  release: {
    label: "releases",
    one: "release",
    lede: "One row per GitHub release or tag. The verdict is the run at the tagged commit; the trend is every run since the previous tag.",
  },
  branch: {
    label: "branches",
    one: "branch",
    lede: "One row per branch. Compared with the default branch.",
  },
  pull_request: {
    label: "pull requests",
    one: "pull request",
    lede: "One row per pull request with runs. Compared with its base branch.",
  },
  environment: {
    label: "environments",
    one: "environment",
    lede: "One row per test environment a report names. Compared with the run before.",
  },
  tag: {
    label: "tags",
    one: "tag",
    lede: "One row per tag set at upload. A run can be in several.",
  },
  tool: {
    label: "tools",
    one: "tool",
    lede: "One row per test tool: playwright, pytest, deepeval.",
  },
  workflow: { label: "workflows", one: "workflow", lede: "One row per CI workflow." },
  repo: { label: "repositories", one: "repository", lede: "One row per repository." },
  day: { label: "days", one: "day", lede: "One row per day, newest first." },
  run: { label: "runs", one: "run", lede: "Every run, newest first." },
};

// ---------------------------------------------------------------------------
// Inputs

/** A report as the index holds it, plus the fields groupings need. */
export interface ReportLite {
  readonly reportId: string;
  readonly runId: string;
  readonly owner: string;
  readonly repo: string;
  readonly tool: string;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly workflow: string | null;
  readonly environment: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly timestamp: string;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly duration: number;
  readonly buildUrl: string | null;
}

export const RefKind = Schema.Literals(["release", "tag", "pull_request", "deployment"]);
export type RefKind = typeof RefKind.Type;

/** Something GitHub knows about a commit or a branch: a release, a tag, a pull request, a deployment. */
export const Ref = Schema.Struct({
  kind: RefKind,
  key: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  commit: Schema.NullOr(Schema.String),
  /** The branch the ref points at: a release's target, a pull request's head. */
  branch: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  /** A pull request's base branch, a deployment's environment, a release's prerelease flag. */
  meta: Schema.Record(Schema.String, Schema.Unknown),
});
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Collection = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.String,
  query: Schema.String,
  createdAt: Schema.String,
});
export interface Collection extends Schema.Schema.Type<typeof Collection> {}
export const CollectionInput = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  query: Schema.String,
});

// ---------------------------------------------------------------------------
// Outputs

export type Verdict = "passed" | "failed" | "none";

export interface TrendPoint {
  readonly runId: string;
  readonly timestamp: string;
  readonly passRate: number;
  readonly failed: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly timestamp: string;
  readonly tools: ReadonlyArray<string>;
  readonly reportIds: ReadonlyArray<string>;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly duration: number;
  readonly passRate: number;
  readonly buildUrl: string | null;
}

export interface GroupRow {
  readonly by: GroupBy;
  readonly key: string;
  readonly label: string;
  readonly owner: string;
  readonly repo: string;
  readonly facts: ReadonlyArray<string>;
  readonly verdict: Verdict;
  readonly latest: RunSummary | null;
  readonly runs: number;
  readonly trend: ReadonlyArray<TrendPoint>;
  /** Pass-rate difference against the baseline, in percentage points. */
  readonly vsBaseline: number | null;
  readonly baselineLabel: string | null;
  readonly baselineRun: RunSummary | null;
  readonly lastAt: string;
  readonly ref: Ref | null;
}

// ---------------------------------------------------------------------------
// Runs from reports

export function summarizeRun(reports: ReadonlyArray<ReportLite>): RunSummary {
  const first = reports[0];
  if (!first) throw new Error("summarizeRun: no reports");
  const sum = (f: (r: ReportLite) => number) => reports.reduce((a, r) => a + f(r), 0);
  const tests = sum((r) => r.tests);
  const passed = sum((r) => r.passed);
  const failed = sum((r) => r.failed);
  const counted = passed + failed;
  const latestTs =
    reports
      .map((r) => r.timestamp)
      .sort()
      .at(-1) ?? first.timestamp;
  return {
    runId: first.runId,
    owner: first.owner,
    repo: first.repo,
    branch: first.branch,
    commit: first.commit,
    timestamp: latestTs,
    tools: [...new Set(reports.map((r) => r.tool))].sort(),
    reportIds: reports.map((r) => r.reportId),
    tests,
    passed,
    failed,
    skipped: sum((r) => r.skipped),
    flaky: sum((r) => r.flaky),
    duration: sum((r) => r.duration),
    passRate: counted === 0 ? 1 : passed / counted,
    buildUrl: first.buildUrl,
  };
}

const runKey = (r: { owner: string; repo: string; runId: string }) =>
  `${r.owner}/${r.repo}#${r.runId}`;

/** Reports grouped into runs, newest first. */
export function runsOf(reports: ReadonlyArray<ReportLite>): RunSummary[] {
  const byRun = new Map<string, ReportLite[]>();
  for (const r of reports) {
    const k = runKey(r);
    byRun.set(k, [...(byRun.get(k) ?? []), r]);
  }
  return [...byRun.values()]
    .map(summarizeRun)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ---------------------------------------------------------------------------
// Assignments from refs

export interface Assigned {
  readonly release: Ref | "unreleased" | null;
  readonly pullRequest: Ref | null;
}

const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner === b.owner && a.repo === b.repo;

/** Which release and pull request a run belongs to, from the refs of its repository. */
export function assign(
  run: {
    owner: string;
    repo: string;
    branch: string | null;
    commit: string | null;
    timestamp: string;
  },
  refs: ReadonlyArray<Ref>,
): Assigned {
  const mine = refs.filter((r) => sameRepo(r, run));
  const releases = mine
    .filter((r) => r.kind === "release" || r.kind === "tag")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let release: Assigned["release"] = null;
  if (releases.length) {
    const atCommit = releases.find(
      (r) => r.commit && run.commit && r.commit.startsWith(run.commit.slice(0, 7)),
    );
    const onTarget = releases.filter((r) => !r.branch || r.branch === run.branch);
    release =
      atCommit ??
      onTarget.find((r) => r.timestamp >= run.timestamp) ??
      (onTarget.length ? "unreleased" : null);
  }
  const prs = mine.filter((r) => r.kind === "pull_request");
  const pullRequest =
    prs.find(
      (r) =>
        r.branch &&
        r.branch === run.branch &&
        r.timestamp <= run.timestamp &&
        (typeof r.meta.closedAt !== "string" || r.meta.closedAt >= run.timestamp),
    ) ?? null;
  return { release, pullRequest };
}

// ---------------------------------------------------------------------------
// Filters

const dayOf = (ts: string) => ts.slice(0, 10);

function matchEnum(actual: ReadonlyArray<string | null>, f: Filter): boolean {
  const vals = actual.filter((v): v is string => v !== null).map((v) => v.toLowerCase());
  const want = f.value.toLowerCase();
  switch (f.op) {
    case "is":
      return vals.includes(want);
    case "not":
      return !vals.includes(want);
    case "in":
      return (f.values ?? []).some((w) => vals.includes(w.toLowerCase()));
    case "contains":
      return vals.some((v) => v.includes(want));
    default:
      return true;
  }
}

function matchNumber(actual: number, f: Filter): boolean {
  const n = Number(f.value);
  if (!Number.isFinite(n)) return true;
  switch (f.op) {
    case "gt":
      return actual > n;
    case "lt":
      return actual < n;
    case "not":
      return actual !== n;
    default:
      return actual === n;
  }
}

export function matches(r: ReportLite, a: Assigned, f: Filter): boolean {
  switch (f.field) {
    case "org":
      return matchEnum([r.owner], f);
    case "repo":
      return matchEnum([`${r.owner}/${r.repo}`, r.repo], f);
    case "branch":
      return matchEnum([r.branch], f);
    case "commit":
      return matchEnum([r.commit], f);
    case "tool":
      return matchEnum([r.tool], f);
    case "workflow":
      return matchEnum([r.workflow], f);
    case "environment":
      return matchEnum([r.environment], f);
    case "tag":
      return matchEnum(r.tags, f);
    case "day":
      return matchEnum([dayOf(r.timestamp)], f);
    case "release":
      return matchEnum(
        [a.release === null ? null : a.release === "unreleased" ? "unreleased" : a.release.key],
        f,
      );
    case "pull_request":
      return matchEnum([a.pullRequest?.key ?? null], f);
    case "failed":
      return matchNumber(r.failed, f);
    case "passed":
      return matchNumber(r.passed, f);
    case "flaky":
      return matchNumber(r.flaky, f);
    case "tests":
      return matchNumber(r.tests, f);
    case "text": {
      const hay = [
        r.runId,
        r.branch,
        r.commit,
        r.tool,
        r.workflow,
        r.environment,
        ...r.tags,
        `${r.owner}/${r.repo}`,
      ]
        .filter((v): v is string => v !== null)
        .join(" ")
        .toLowerCase();
      return f.value
        .toLowerCase()
        .split(/\s+/)
        .every((w) => hay.includes(w));
    }
  }
}

// ---------------------------------------------------------------------------
// Grouping

export interface GroupInput {
  readonly reports: ReadonlyArray<ReportLite>;
  readonly refs: ReadonlyArray<Ref>;
  readonly by: GroupBy;
  readonly filters: ReadonlyArray<Filter>;
  /** ISO timestamp: only reports at or after it count. */
  readonly since?: string | undefined;
  readonly trendPoints?: number | undefined;
  readonly defaultBranch?: string | undefined;
}

interface Bucket {
  readonly key: string;
  readonly label: string;
  readonly owner: string;
  readonly repo: string;
  readonly reports: ReportLite[];
  readonly ref: Ref | null;
}

const DEFAULT_BRANCHES = ["main", "master", "trunk", "develop"];

/**
 * A repository's default branch: a conventional name seen in its runs, else the branch its
 * pull requests target most, else the branch with the most runs. The source never says.
 */
export function defaultBranchOf(
  runs: ReadonlyArray<{ readonly branch: string | null }>,
  refs: ReadonlyArray<Ref>,
  repo: { readonly owner: string; readonly repo: string },
): string | null {
  const seen = new Map<string, number>();
  for (const r of runs) if (r.branch) seen.set(r.branch, (seen.get(r.branch) ?? 0) + 1);
  const conventional = DEFAULT_BRANCHES.find((b) => seen.has(b));
  if (conventional) return conventional;
  const bases = new Map<string, number>();
  for (const r of refs)
    if (r.kind === "pull_request" && sameRepo(r, repo) && typeof r.meta.base === "string")
      bases.set(r.meta.base, (bases.get(r.meta.base) ?? 0) + 1);
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top(bases) ?? top(seen) ?? null;
}

export function keysOf(
  r: ReportLite,
  a: Assigned,
  by: GroupBy,
): ReadonlyArray<{ key: string; label: string; ref: Ref | null }> {
  switch (by) {
    case "repo":
      return [{ key: `${r.owner}/${r.repo}`, label: `${r.owner}/${r.repo}`, ref: null }];
    case "branch":
      return r.branch ? [{ key: r.branch, label: r.branch, ref: null }] : [];
    case "tool":
      return [{ key: r.tool, label: r.tool, ref: null }];
    case "workflow":
      return r.workflow ? [{ key: r.workflow, label: r.workflow, ref: null }] : [];
    case "environment":
      return r.environment ? [{ key: r.environment, label: r.environment, ref: null }] : [];
    case "tag":
      return r.tags.map((t) => ({ key: t, label: t, ref: null }));
    case "day":
      return [{ key: dayOf(r.timestamp), label: dayOf(r.timestamp), ref: null }];
    case "run":
      return [{ key: r.runId, label: r.runId, ref: null }];
    case "release":
      if (a.release === null) return [];
      if (a.release === "unreleased")
        return [{ key: "unreleased", label: "unreleased", ref: null }];
      return [{ key: a.release.key, label: a.release.key, ref: a.release }];
    case "pull_request":
      return a.pullRequest
        ? [
            {
              key: a.pullRequest.key,
              label: a.pullRequest.title
                ? `${a.pullRequest.key} · ${a.pullRequest.title}`
                : a.pullRequest.key,
              ref: a.pullRequest,
            },
          ]
        : [];
  }
}

const pct = (x: number) => Math.round(x * 1000) / 10;

/** The reports in range that pass every filter, with each run's assignment memoised. */
export function matching(input: Omit<GroupInput, "by" | "trendPoints" | "defaultBranch">) {
  const assigned = new Map<string, Assigned>();
  const assignedOf = (r: ReportLite) => {
    const k = runKey(r);
    let a = assigned.get(k);
    if (!a) {
      a = assign(r, input.refs);
      assigned.set(k, a);
    }
    return a;
  };
  const inRange = input.since
    ? input.reports.filter((r) => r.timestamp >= (input.since ?? ""))
    : input.reports;
  const kept = inRange.filter((r) => input.filters.every((f) => matches(r, assignedOf(r), f)));
  return { inRange, kept, assignedOf };
}

export function computeGroups(input: GroupInput): GroupRow[] {
  const { by } = input;
  const trendPoints = input.trendPoints ?? 14;
  const { inRange, kept, assignedOf } = matching(input);

  const buckets = new Map<string, Bucket>();
  for (const r of kept) {
    for (const k of keysOf(r, assignedOf(r), by)) {
      const id =
        by === "repo" || by === "tool" || by === "day" || by === "tag"
          ? k.key
          : `${r.owner}/${r.repo}::${k.key}`;
      const b = buckets.get(id);
      if (b) b.reports.push(r);
      else
        buckets.set(id, {
          key: k.key,
          label: k.label,
          owner: r.owner,
          repo: r.repo,
          reports: [r],
          ref: k.ref,
        });
    }
  }

  // Runs per bucket, and the baseline each bucket compares against.
  const allRunsByRepo = new Map<string, RunSummary[]>();
  for (const run of runsOf(inRange)) {
    const k = `${run.owner}/${run.repo}`;
    allRunsByRepo.set(k, [...(allRunsByRepo.get(k) ?? []), run]);
  }
  const defaultBranchFor = (owner: string, repo: string) =>
    input.defaultBranch ??
    defaultBranchOf(allRunsByRepo.get(`${owner}/${repo}`) ?? [], input.refs, { owner, repo });

  const rows: GroupRow[] = [];
  const bucketRuns = new Map<string, RunSummary[]>();
  for (const [id, b] of buckets) bucketRuns.set(id, runsOf(b.reports));

  for (const [id, b] of buckets) {
    const runs = bucketRuns.get(id) ?? [];
    // For a release, the verdict is the run at the tagged commit when there is one.
    const atTag = b.ref?.commit
      ? runs.find((r) => r.commit && b.ref?.commit?.startsWith(r.commit.slice(0, 7)))
      : undefined;
    const latest = atTag ?? runs[0] ?? null;
    const verdict: Verdict = latest === null ? "none" : latest.failed > 0 ? "failed" : "passed";

    let baselineRun: RunSummary | null = null;
    let baselineLabel: string | null = null;
    const previousRun = latest ? (runs.find((r) => r.timestamp < latest.timestamp) ?? null) : null;
    if (by === "release" && b.ref) {
      const mine = [...buckets.values()]
        .filter((o) => o.ref && sameRepo(o, b) && o.ref.timestamp < (b.ref?.timestamp ?? ""))
        .sort((x, y) => (y.ref?.timestamp ?? "").localeCompare(x.ref?.timestamp ?? ""));
      const prev = mine[0];
      if (prev) {
        const prevRuns = runsOf(prev.reports);
        const prevAtTag = prev.ref?.commit
          ? prevRuns.find((r) => r.commit && prev.ref?.commit?.startsWith(r.commit.slice(0, 7)))
          : undefined;
        baselineRun = prevAtTag ?? prevRuns[0] ?? null;
        baselineLabel = prev.key;
      }
    } else if (by === "release" && b.key === "unreleased") {
      const released = [...buckets.values()]
        .filter((o) => o.ref && sameRepo(o, b))
        .sort((x, y) => (y.ref?.timestamp ?? "").localeCompare(x.ref?.timestamp ?? ""));
      const last = released[0];
      if (last) {
        baselineRun = runsOf(last.reports)[0] ?? null;
        baselineLabel = last.key;
      }
    } else if (by === "branch" || by === "pull_request") {
      const base =
        by === "pull_request"
          ? typeof b.ref?.meta.base === "string"
            ? b.ref.meta.base
            : null
          : defaultBranchFor(b.owner, b.repo);
      if (base && base !== b.key) {
        baselineRun =
          (allRunsByRepo.get(`${b.owner}/${b.repo}`) ?? []).find((r) => r.branch === base) ?? null;
        baselineLabel = base;
      } else {
        baselineRun = previousRun;
        baselineLabel = previousRun ? "previous run" : null;
      }
    } else {
      baselineRun = previousRun;
      baselineLabel = previousRun ? "previous run" : null;
    }

    const trend = [...runs]
      .reverse()
      .slice(-trendPoints)
      .map((r) => ({
        runId: r.runId,
        timestamp: r.timestamp,
        passRate: r.passRate,
        failed: r.failed,
      }));
    const facts: string[] = [];
    if (by !== "repo") facts.push(`${b.owner}/${b.repo}`);
    if (latest?.commit && by !== "run") facts.push(latest.commit.slice(0, 7));
    if (latest?.branch && by !== "branch" && by !== "pull_request") facts.push(latest.branch);
    if (b.ref?.kind === "release" && b.ref.meta.prerelease === true) facts.push("pre-release");
    if (by === "pull_request" && typeof b.ref?.meta.base === "string")
      facts.push(`into ${b.ref.meta.base}`);
    const tools = [...new Set(b.reports.map((r) => r.tool))].sort();
    if (by !== "tool") facts.push(tools.join(" · "));

    rows.push({
      by,
      key: b.key,
      label: b.label,
      owner: b.owner,
      repo: b.repo,
      facts,
      verdict,
      latest,
      runs: runs.length,
      trend,
      vsBaseline: latest && baselineRun ? pct(latest.passRate) - pct(baselineRun.passRate) : null,
      baselineLabel,
      baselineRun,
      lastAt: runs[0]?.timestamp ?? "",
      ref: b.ref,
    });
  }

  rows.sort((a, b2) => {
    if (by === "release" && a.ref && b2.ref) return b2.ref.timestamp.localeCompare(a.ref.timestamp);
    if (by === "release" && (a.key === "unreleased") !== (b2.key === "unreleased"))
      return a.key === "unreleased" ? -1 : 1;
    return b2.lastAt.localeCompare(a.lastAt);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Suggestions for the search bar

export interface ValueIndex {
  /** field -> value -> report count */
  readonly values: ReadonlyMap<Field, ReadonlyMap<string, number>>;
}

export function indexValues(
  reports: ReadonlyArray<ReportLite>,
  refs: ReadonlyArray<Ref>,
): ValueIndex {
  const values = new Map<Field, Map<string, number>>();
  const bump = (f: Field, v: string | null) => {
    if (v === null || v === "") return;
    const m = values.get(f) ?? new Map<string, number>();
    m.set(v, (m.get(v) ?? 0) + 1);
    values.set(f, m);
  };
  for (const r of reports) {
    const a = assign(r, refs);
    bump("org", r.owner);
    bump("repo", `${r.owner}/${r.repo}`);
    bump("branch", r.branch);
    bump("tool", r.tool);
    bump("workflow", r.workflow);
    bump("environment", r.environment);
    for (const t of r.tags) bump("tag", t);
    bump("day", dayOf(r.timestamp));
    bump(
      "release",
      a.release === null ? null : a.release === "unreleased" ? "unreleased" : a.release.key,
    );
    bump("pull_request", a.pullRequest?.key ?? null);
  }
  return { values };
}

export interface Suggestion {
  readonly kind: "field" | "value" | "text";
  readonly field: Field | null;
  readonly value: string;
  readonly count: number | null;
  readonly note: string;
  /** What to append to the query when chosen. */
  readonly token: string;
}

/** Suggestions for the word being typed: fields first, then values, then text search. */
export function suggest(index: ValueIndex, typed: string, limit = 8): Suggestion[] {
  const raw = typed.trim();
  if (!raw) return [];
  const out: Suggestion[] = [];
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const field = fieldOf(raw.slice(0, colon));
    const partial = raw.slice(colon + 1).toLowerCase();
    if (field) {
      const vals = [...(index.values.get(field) ?? new Map<string, number>()).entries()]
        .filter(([v]) => v.toLowerCase().includes(partial))
        .sort((a, b) => b[1] - a[1]);
      for (const [v, n] of vals.slice(0, limit))
        out.push({
          kind: "value",
          field,
          value: v,
          count: n,
          note: "",
          token: `${field}:${quote(v)}`,
        });
      if (FIELD_INFO[field].kind === "number" && partial === "") {
        out.push({
          kind: "value",
          field,
          value: "> 0",
          count: null,
          note: "",
          token: `${field}:>0`,
        });
      }
    }
    return out;
  }
  const q = raw.toLowerCase();
  for (const f of FIELDS) {
    if (f === "text") continue;
    const hit =
      f.startsWith(q) ||
      FIELD_INFO[f].label.startsWith(q) ||
      Object.entries(ALIASES).some(([a, t]) => t === f && a.startsWith(q));
    if (!hit) continue;
    const n = index.values.get(f)?.size ?? 0;
    out.push({
      kind: "field",
      field: f,
      value: FIELD_INFO[f].label,
      count: FIELD_INFO[f].kind === "enum" ? n : null,
      note: `from ${FIELD_INFO[f].from}`,
      token: `${f}:`,
    });
  }
  const valueHits: Suggestion[] = [];
  for (const [f, m] of index.values) {
    for (const [v, n] of m) {
      if (v.toLowerCase().includes(q))
        valueHits.push({
          kind: "value",
          field: f,
          value: v,
          count: n,
          note: "",
          token: `${f}:${quote(v)}`,
        });
    }
  }
  valueHits.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  out.push(...valueHits.slice(0, Math.max(0, limit - out.length)));
  out.push({
    kind: "text",
    field: null,
    value: raw,
    count: null,
    note: "search",
    token: quote(raw),
  });
  return out;
}

/** The range selector: how far back the home page looks. */
export const RANGES = ["1d", "7d", "30d", "90d", "all"] as const;
export type Range = (typeof RANGES)[number];
export const isRange = (s: string): s is Range => (RANGES as ReadonlyArray<string>).includes(s);
export function sinceOf(range: Range, now = new Date()): string | undefined {
  const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, all: 0 }[range];
  if (!days) return undefined;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// The overview: what state each repository is in, before any grouping

export interface RecentRun {
  readonly run: RunSummary;
  readonly reports: ReadonlyArray<ReportLite>;
  readonly release: string | null;
  readonly pullRequest: string | null;
}

export interface RepoOverview {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string | null;
  /** The latest run on the default branch, against the one before it. */
  readonly main: {
    readonly run: RunSummary | null;
    readonly vsPrevious: number | null;
    readonly trend: ReadonlyArray<TrendPoint>;
  };
  /** The newest release or tag with its verdict. */
  readonly release: GroupRow | null;
  readonly pullRequests: {
    readonly open: number;
    readonly failing: number;
    readonly rows: ReadonlyArray<GroupRow>;
  };
  readonly flaky: number;
  readonly runs: number;
  readonly recent: ReadonlyArray<RecentRun>;
}

const isOpen = (r: Ref) => r.kind === "pull_request" && typeof r.meta.closedAt !== "string";

export function computeOverview(input: {
  readonly reports: ReadonlyArray<ReportLite>;
  readonly refs: ReadonlyArray<Ref>;
  readonly since?: string | undefined;
  readonly recent?: number | undefined;
}): RepoOverview[] {
  const { refs } = input;
  const recentN = input.recent ?? 8;
  const inRange = input.since
    ? input.reports.filter((r) => r.timestamp >= (input.since ?? ""))
    : input.reports;
  const byRepo = new Map<string, ReportLite[]>();
  for (const r of inRange) {
    const k = `${r.owner}/${r.repo}`;
    byRepo.set(k, [...(byRepo.get(k) ?? []), r]);
  }
  const out: RepoOverview[] = [];
  for (const reports of byRepo.values()) {
    const first = reports[0];
    if (!first) continue;
    const { owner, repo } = first;
    const runs = runsOf(reports);
    const defaultBranch = defaultBranchOf(runs, refs, { owner, repo });
    const mainRuns = runs.filter((r) => r.branch === defaultBranch);
    const mainRun = mainRuns[0] ?? null;
    const before = mainRuns[1];
    const main = {
      run: mainRun,
      vsPrevious: mainRun && before ? pct(mainRun.passRate) - pct(before.passRate) : null,
      trend: [...mainRuns]
        .reverse()
        .slice(-14)
        .map((r) => ({
          runId: r.runId,
          timestamp: r.timestamp,
          passRate: r.passRate,
          failed: r.failed,
        })),
    };
    const releases = computeGroups({ reports, refs, by: "release", filters: [] });
    const release = releases.find((g) => g.ref !== null) ?? null;
    const openKeys = new Set(
      refs.filter((r) => isOpen(r) && r.owner === owner && r.repo === repo).map((r) => r.key),
    );
    const prRows = computeGroups({ reports, refs, by: "pull_request", filters: [] }).filter((g) =>
      openKeys.has(g.key),
    );
    const byRun = new Map<string, ReportLite[]>();
    for (const r of reports) byRun.set(r.runId, [...(byRun.get(r.runId) ?? []), r]);
    const recent = runs.slice(0, recentN).map((run): RecentRun => {
      const a = assign(run, refs);
      return {
        run,
        reports: [...(byRun.get(run.runId) ?? [])].sort((x, y) => x.tool.localeCompare(y.tool)),
        release: a.release === null ? null : a.release === "unreleased" ? null : a.release.key,
        pullRequest: a.pullRequest?.key ?? null,
      };
    });
    out.push({
      owner,
      repo,
      defaultBranch,
      main,
      release,
      pullRequests: {
        open: openKeys.size,
        failing: prRows.filter((g) => g.verdict === "failed").length,
        rows: prRows,
      },
      flaky: mainRun?.flaky ?? 0,
      runs: runs.length,
      recent,
    });
  }
  out.sort((a, b) =>
    (b.recent[0]?.run.timestamp ?? "").localeCompare(a.recent[0]?.run.timestamp ?? ""),
  );
  return out;
}
