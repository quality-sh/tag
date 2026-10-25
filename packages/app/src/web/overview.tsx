// The home page: what state each repository is in, before any grouping.
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Bad,
  Bars,
  Cmd,
  Delta,
  Empty,
  K,
  Link,
  Mark,
  Name,
  Section,
  Seg,
  Toolbar,
  Shell,
  Space,
  Strip,
  Table,
  Topbar,
  TopbarAction,
  fmtDay,
  fmtWhen,
  plural,
  type Column,
  type StripItem,
} from "@quality-sh/tag-ui";
import { RANGES, type Range, type RecentRun, type RepoOverview } from "../grouping.ts";
import { BackfillStatus, backfillOf, progressText, useBackfilling } from "./backfill.tsx";
import type { RepositoryState } from "./client.ts";
import { Loaded, SignOut } from "./common.tsx";
import { CollectionsTable, Rail } from "./home.tsx";
import { href, ingestFn, overviewAtom, overviewKey } from "./state.ts";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function OverviewPage({ range }: { range: Range }) {
  const result = useAtomValue(overviewAtom(overviewKey({ range, q: "" })));
  const data = AsyncResult.isSuccess(result) ? result.value : undefined;
  const [ingest, runIngest] = useAtom(ingestFn);
  const ingesting = AsyncResult.isWaiting(ingest);
  const backfilling = useBackfilling();
  return (
    <>
      <Topbar
        wordmark="TAG"
        href={href.overview()}
        crumbs={[{ label: "Overview" }]}
        actions={
          <>
            <TopbarAction href={href.collections()}>collections</TopbarAction>
            <SignOut />
          </>
        }
      />
      <Shell
        rail={
          <Rail overview range={range} collections={data?.collections} repos={data?.repoList} />
        }
      >
        <Space top={28}>
          <Toolbar>
            <Seg<Range>
              label="Time range"
              value={range}
              onChange={(r) => {
                location.hash = href.overview(r);
              }}
              options={RANGES.map((r) => ({ value: r, label: r }))}
            />
            <Cmd small onClick={() => runIngest()} disabled={ingesting}>
              {ingesting ? "checking…" : "check for new runs"}
            </Cmd>
            {!ingesting && AsyncResult.isSuccess(ingest) && (
              <span role="status">
                <K>
                  {ingest.value.inserted} new reports · {ingest.value.errors.length} errors
                </K>
              </span>
            )}
            {!ingesting && AsyncResult.isFailure(ingest) && (
              <span role="status">
                <K tone="bad">Check failed. Try again.</K>
              </span>
            )}
            <BackfillStatus states={backfilling} />
          </Toolbar>
        </Space>
        <Loaded result={result}>
          {(d) => (
            <>
              {d.repos.length === 0 && (
                <Empty>No runs in this range. Widen it, or check for new runs.</Empty>
              )}
              {d.repos.map((r, i) => (
                <Repository
                  key={`${r.owner}/${r.repo}`}
                  r={r}
                  range={range}
                  first={i === 0}
                  link
                  state={backfillOf(backfilling, r.owner, r.repo)}
                />
              ))}
              {d.collections.length > 0 && (
                <Section eyebrow="Collections" count={plural(d.collections.length, "collection")}>
                  <CollectionsTable rows={d.collections} />
                </Section>
              )}
            </>
          )}
        </Loaded>
      </Shell>
    </>
  );
}

/** One repository's state: the strip and its recent runs. `link` sends the eyebrow to its page. */
export function Repository({
  r,
  range,
  first,
  link,
  state,
}: {
  r: RepoOverview;
  range: Range;
  first: boolean;
  link?: boolean;
  /** Its ingest state, when it is still backfilling. */
  state?: RepositoryState | undefined;
}) {
  const main = r.main.run;
  const view = { range, q: `repo:${r.owner}/${r.repo}` };
  const scope = { kind: "repo", owner: r.owner, repo: r.repo } as const;
  const items: StripItem[] = [
    {
      key: "main",
      label: r.defaultBranch ?? "default branch",
      value: main ? (
        <Mark tone={main.failed > 0 ? "failed" : "passed"}>
          {main.failed > 0 ? "failed" : "passed"}
        </Mark>
      ) : (
        <Mark tone="quiet">no runs</Mark>
      ),
      note: main ? (
        <>
          {pct(main.passRate)}
          {r.main.vsPrevious !== null && (
            <>
              {" · "}
              <Delta pp={r.main.vsPrevious} />
            </>
          )}
          {" · "}
          {fmtWhen(main.timestamp)}
        </>
      ) : undefined,
      bars:
        r.main.trend.length >= 4
          ? { values: r.main.trend.map((t) => t.passRate), tone: "passed" }
          : undefined,
    },
    {
      key: "release",
      label: "latest release",
      value: r.release ? (
        <Link ink href={href.group("release", r.release.key, view)}>
          {r.release.label}
        </Link>
      ) : (
        <K tone="dim">none</K>
      ),
      note: r.release ? (
        <>
          <Mark tone={r.release.verdict === "failed" ? "failed" : "passed"}>
            {r.release.verdict}
          </Mark>
          {r.release.ref ? ` · tagged ${fmtDay(r.release.ref.timestamp)}` : ""}
        </>
      ) : (
        "no release or tag yet"
      ),
    },
    {
      key: "prs",
      label: "open pull requests",
      value: r.pullRequests.open,
      tone: r.pullRequests.failing > 0 ? "failed" : r.pullRequests.open ? undefined : "quiet",
      note:
        r.pullRequests.open === 0
          ? "none open"
          : r.pullRequests.failing > 0
            ? `${r.pullRequests.failing} failing`
            : "all passing",
    },
    {
      key: "flaky",
      label: "flaky",
      value: r.flaky,
      tone: r.flaky > 0 ? "flaky" : "quiet",
      note: main ? `tests in the latest ${r.defaultBranch ?? ""} run` : undefined,
    },
  ];
  const columns: Column<RecentRun>[] = [
    {
      key: "run",
      head: "Run",
      wrap: true,
      cell: (x) => (
        <Name sub={[x.run.branch, x.run.commit?.slice(0, 7)].filter(Boolean).join(" · ")}>
          <Link ink href={href.report(x.run.reportIds[0] ?? "")}>
            {x.run.runId}
          </Link>
        </Name>
      ),
    },
    {
      key: "where",
      head: "In",
      dim: true,
      cell: (x) =>
        x.pullRequest ? (
          <Link href={href.group("pull_request", x.pullRequest, view)}>{x.pullRequest}</Link>
        ) : x.release ? (
          <Link href={href.group("release", x.release, view)}>{x.release}</Link>
        ) : (
          "—"
        ),
    },
    {
      key: "verdict",
      head: "Verdict",
      cell: (x) => (
        <Mark tone={x.run.failed > 0 ? "failed" : "passed"}>
          {x.run.failed > 0 ? "failed" : "passed"}
        </Mark>
      ),
    },
    {
      key: "tools",
      head: "Tools",
      cell: (x) => (
        <span
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(3rem, 9rem)",
            rowGap: 4,
            columnGap: 8,
            alignItems: "center",
          }}
        >
          {x.reports.map((p) => (
            <ToolBar key={p.reportId} p={p} />
          ))}
        </span>
      ),
    },
    {
      key: "passed",
      head: "Passed",
      right: true,
      cell: (x) => <K tone="good">{x.run.passed}</K>,
    },
    {
      key: "failed",
      head: "Failed",
      right: true,
      cell: (x) => (x.run.failed ? <Bad>{x.run.failed}</Bad> : <K tone="dim">0</K>),
    },
    {
      key: "when",
      head: "When",
      right: true,
      dim: true,
      hideUnder: 900,
      cell: (x) => <span title={x.run.timestamp}>{fmtWhen(x.run.timestamp)}</span>,
    },
  ];
  return (
    <Section
      eyebrow={
        <>
          {link ? (
            <Link ink href={href.scope(scope, { range })}>
              {r.owner}/{r.repo} →
            </Link>
          ) : (
            `${r.owner}/${r.repo}`
          )}
          {state && state.state !== "current" && (
            <>
              {" · "}
              <K tone="dim">{progressText(state)}</K>
            </>
          )}
        </>
      }
      count={<Link href={href.home({ ...view, by: "run" })}>{plural(r.runs, "run")}</Link>}
      first={first}
    >
      <Strip label={`${r.owner}/${r.repo} now`} items={items} />
      <Space top={18}>
        <Table middle columns={columns} rows={r.recent} rowKey={(x) => x.run.runId} />
      </Space>
    </Section>
  );
}

function ToolBar({ p }: { p: RecentRun["reports"][number] }) {
  return (
    <>
      <Link ink href={href.report(p.reportId)}>
        <K>{p.tool}</K>
      </Link>
      <Bars
        thin
        keys={false}
        label={`${p.tool}: ${p.passed} passed, ${p.failed} failed, ${p.flaky} flaky, ${p.skipped} skipped`}
        segments={[
          { tone: "passed", value: p.passed - p.flaky, label: "passed" },
          { tone: "flaky", value: p.flaky, label: "flaky" },
          { tone: "failed", value: p.failed, label: "failed" },
          { tone: "skipped", value: p.skipped, label: "skipped" },
        ]}
      />
    </>
  );
}
