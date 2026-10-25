// Filters applied to a report: which reports a query keeps.
import type { Filter } from "./query.ts";
import type { Assigned } from "./refs.ts";
import type { ReportLite } from "./report.ts";

export const dayOf = (ts: string) => ts.slice(0, 10);

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
