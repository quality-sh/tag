// The groups table: one row per group, its columns, sectioned by repository.
import {
  Bad,
  Delta,
  Empty,
  HeadRow,
  K,
  Link,
  Name,
  Spark,
  Table,
  fmtMs,
  fmtWhen,
  plural,
  type Column,
} from "@quality-sh/tag-ui";
import { GROUP_BY_INFO, type GroupRow } from "../../grouping.ts";
import { cap } from "../common.tsx";
import type { GroupsPage } from "../client.ts";
import { href, type View } from "../state.ts";
import { Dim, Good, Verdict } from "./bits.tsx";

/** Rows of groups, sectioned by repository unless `flat`; `limit` keeps the newest few. */
export function GroupsTable({
  d,
  view,
  flat,
  limit,
}: {
  d: GroupsPage;
  view: View;
  flat?: boolean;
  limit?: number;
}) {
  const by = d.by;
  const groups = limit === undefined ? d.groups : d.groups.slice(0, limit);
  const nameOf = (g: GroupRow) =>
    by === "run" && g.latest
      ? href.report(g.latest.reportIds[0] ?? "")
      : href.group(by, g.key, view);
  // The table is sectioned by repository, so the repository fact is already said.
  const facts = (g: GroupRow) => g.facts.filter((f) => f !== `${g.owner}/${g.repo}`);
  const columns: Column<GroupRow>[] = [
    {
      key: "name",
      head: cap(GROUP_BY_INFO[by].one),
      wrap: true,
      cell: (g) => (
        <Name sub={facts(g).join(" · ")}>
          <Link ink href={nameOf(g)}>
            {g.label}
          </Link>
        </Name>
      ),
    },
    {
      key: "verdict",
      head: "Verdict",
      cell: (g) => <Verdict failed={g.verdict === "failed"} none={g.verdict === "none"} />,
    },
    { key: "passed", head: "Passed", right: true, cell: (g) => <Good n={g.latest?.passed} /> },
    {
      key: "failed",
      head: "Failed",
      right: true,
      cell: (g) => (g.latest?.failed ? <Bad>{g.latest.failed}</Bad> : <Dim>0</Dim>),
    },
    {
      key: "flaky",
      head: "Flaky",
      right: true,
      cell: (g) => (g.latest?.flaky ? <K tone="warn">{g.latest.flaky}</K> : <Dim>0</Dim>),
    },
    {
      key: "skipped",
      head: "Skipped",
      right: true,
      hideUnder: 1280,
      cell: (g) => <Dim>{g.latest?.skipped ?? 0}</Dim>,
    },
    {
      key: "wall",
      head: "Wall time",
      right: true,
      hideUnder: 1280,
      cell: (g) => (g.latest ? fmtMs(g.latest.duration) : "—"),
    },
    {
      key: "vs",
      head: by === "branch" || by === "pull_request" ? "vs base" : "vs previous",
      right: true,
      hideUnder: 900,
      cell: (g) => (
        <Delta
          pp={g.vsBaseline}
          title={g.baselineLabel ? `against ${g.baselineLabel}` : undefined}
        />
      ),
    },
    {
      key: "trend",
      head: "Trend",
      hideUnder: 1100,
      cell: (g) => (
        <Spark
          points={g.trend.map((t) => ({ value: t.passRate, bad: t.failed > 0 }))}
          label={`${g.trend.length} runs`}
        />
      ),
    },
    {
      key: "last",
      head: by === "release" ? "Tagged" : "Last run",
      right: true,
      dim: true,
      cell: (g) => {
        const at = by === "release" && g.ref ? g.ref.timestamp : g.lastAt;
        return at ? <span title={at}>{fmtWhen(at)}</span> : "—";
      },
    },
  ];
  if (groups.length === 0)
    return (
      <Empty>
        No {GROUP_BY_INFO[by].label} match. Loosen the filters, widen the range, or check for new
        runs.
      </Empty>
    );
  const byRepo = new Map<string, GroupRow[]>();
  for (const g of groups) {
    const k = `${g.owner}/${g.repo}`;
    byRepo.set(k, [...(byRepo.get(k) ?? []), g]);
  }
  const sections = [...byRepo.entries()].map(([key, rows]) => ({
    key,
    head: (
      <HeadRow
        title={key}
        count={`${plural(rows.length, GROUP_BY_INFO[by].one)} · ${plural(
          rows.reduce((a, g) => a + g.runs, 0),
          "run",
        )}`}
      />
    ),
    rows,
  }));
  const rowKey = (g: GroupRow) => `${g.owner}/${g.repo}:${g.key}`;
  return by === "repo" || flat ? (
    <Table middle columns={columns} rows={groups} rowKey={rowKey} />
  ) : (
    <Table middle columns={columns} sections={sections} rowKey={rowKey} />
  );
}
