// The report page: one report's facts and pass rate, its failures, and the original
// artifacts, one of which can open inline.
import { useEffect } from "react";
import { Option } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Accent,
  Bad,
  Bars,
  Big,
  Card,
  Cmd,
  Disclosure,
  Facts,
  FigureCell,
  FigureGrid,
  Figures,
  Frame,
  Head,
  Ink,
  Inline,
  K,
  Lead,
  Link,
  Mark,
  Message,
  Page,
  Row,
  Rows,
  Section,
  Space,
  Split,
  Stats,
  Sub,
  Table,
  Topbar,
  Trace,
  Warn,
  basename,
  fmtBytes,
  fmtDay,
  fmtMs,
  fmtPct,
  fmtStamp,
  fmtWhen,
  plural,
  short,
  toneOf,
} from "@quality-sh/tag-ui";
import type { ArtifactRow, ReportDetail, RunRow } from "../client.ts";
import { DeepEval } from "../deepeval.tsx";
import { Loaded, SignOut, segmentsOf } from "../common.tsx";
import { embedAtom, href, openArtifactFn, reportAtom } from "../state.ts";

export function ReportPage({ reportId }: { reportId: string }) {
  const result = useAtomValue(reportAtom(reportId));
  const run = AsyncResult.isSuccess(result) ? result.value.run : undefined;
  return (
    <>
      <Topbar
        wordmark="TAG"
        crumbs={[
          { label: "Overview", href: href.overview() },
          { label: run ? `${run.owner}/${run.repo}` : "…" },
          { label: run?.runId ?? "…" },
          { label: run?.tool ?? "report" },
        ]}
        actions={<SignOut />}
      />
      <Page>
        <Loaded result={result}>{(d) => <ReportBody d={d} reportId={reportId} />}</Loaded>
      </Page>
    </>
  );
}

function ReportBody({ d, reportId }: { d: ReportDetail; reportId: string }) {
  const { run } = d;
  const failing = run.failed > 0;
  const isDeepEval = run.tool.includes("deepeval");
  const failures = d.tests.filter((t) => t.status === "failed");
  const ctrfByTestId = new Map((d.report?.results.tests ?? []).map((t) => [t.testId ?? "", t]));
  return (
    <>
      <Head
        eyebrow={
          <>
            Report · <Accent>{run.tool}</Accent>
            {run.toolVersion ? ` ${run.toolVersion}` : ""}
          </>
        }
        title={run.runId}
        question={`${run.passed} of ${run.tests} tests passed on ${run.branch ?? "an unknown branch"} at ${short(run.commit) || "an unknown commit"}, ${fmtStamp(run.timestamp)}.`}
        facts={[
          `${run.owner}/${run.repo}`,
          run.branch,
          short(run.commit) || null,
          fmtMs(run.duration),
          run.buildUrl ? (
            <Link external href={run.buildUrl}>
              workflow ↗
            </Link>
          ) : null,
          `ingested ${fmtWhen(run.ingestedAt)}`,
          `${run.adapter} adapter`,
        ]}
      />

      <Lead
        aside={
          <>
            {d.siblings.length > 0 && (
              <Card pad={false} head="Also in this run" meta={plural(d.siblings.length, "report")}>
                <Space top={12}>
                  <Figures
                    items={d.siblings.map((s) => ({
                      key: s.reportId,
                      label: <Link href={href.report(s.reportId)}>{s.tool} →</Link>,
                      value: fmtPct(s.passed, s.tests),
                      unit: `${s.passed}/${s.tests} passed`,
                      note: s.failed > 0 ? <Bad>{s.failed} failed</Bad> : fmtMs(s.duration),
                      tone: s.failed > 0 ? "failed" : "metric",
                    }))}
                  />
                </Space>
              </Card>
            )}
            <Artifacts artifacts={d.artifacts} refs={d.artifactRefs} run={run} />
          </>
        }
      >
        <Big
          tone={failing ? "failed" : "metric"}
          title={failing ? "Pass rate, with failures" : "Pass rate"}
        >
          {fmtPct(run.passed, run.tests)}
        </Big>
        <Stats
          items={[
            { label: "passed", value: run.passed, tone: "passed" },
            { label: "failed", value: run.failed, tone: run.failed ? "failed" : undefined },
            { label: "skipped", value: run.skipped },
            ...(run.flaky ? [{ label: "flaky", value: run.flaky, tone: "flaky" as const }] : []),
            { label: "tests", value: run.tests },
          ]}
        />
        <Split>
          <Bars segments={segmentsOf(run)} />
        </Split>
      </Lead>

      <EmbeddedArtifact />

      {failures.length > 0 && !isDeepEval && (
        <Section eyebrow="Failures" count={failures.length}>
          <Rows>
            {failures.map((t) => {
              const full = ctrfByTestId.get(t.testId);
              return (
                <Row
                  key={t.testId + t.name}
                  title={
                    <Link ink href={href.test(run.owner, run.repo, t.testId)}>
                      {t.name}
                    </Link>
                  }
                  facts={
                    <Facts>
                      {[
                        t.suite,
                        t.filePath ? basename(t.filePath) : null,
                        t.retries > 0 ? <Warn>{plural(t.retries, "retry", "retries")}</Warn> : null,
                        fmtMs(t.duration),
                      ]}
                    </Facts>
                  }
                >
                  {t.message && <Message>{t.message}</Message>}
                  {full?.snippet && <Trace>{full.snippet}</Trace>}
                  {full?.trace && (
                    <Space top={10}>
                      <Disclosure summary="stack trace">
                        <Trace>{full.trace}</Trace>
                      </Disclosure>
                    </Space>
                  )}
                </Row>
              );
            })}
          </Rows>
        </Section>
      )}

      {isDeepEval && <DeepEval d={d} />}

      <Section eyebrow="All tests" count={d.tests.length}>
        <Table
          rows={d.tests}
          rowKey={(t) => t.testId + t.name}
          columns={[
            {
              key: "name",
              head: "Test",
              cell: (t) => (
                <>
                  <Link href={href.test(run.owner, run.repo, t.testId)}>{t.name}</Link>
                  {t.filePath && <Sub>{basename(t.filePath)}</Sub>}
                </>
              ),
            },
            { key: "suite", head: "Suite", dim: true, cell: (t) => t.suite },
            {
              key: "status",
              head: "Status",
              cell: (t) => <Mark tone={toneOf(t.status, t.flaky)} />,
            },
            { key: "duration", head: "Duration", right: true, cell: (t) => fmtMs(t.duration) },
          ]}
        />
      </Section>
      <Space top={32}>
        <K block tone="dim">
          report {reportId}
        </K>
      </Space>
    </>
  );
}

function Artifacts({
  artifacts,
  refs,
  run,
}: {
  artifacts: ReadonlyArray<ArtifactRow>;
  refs: ReportDetail["artifactRefs"];
  run: RunRow;
}) {
  const [opening, open] = useAtom(openArtifactFn);
  const setEmbed = useAtomSet(embedAtom);
  const own = artifacts.find((a) => a.artifactId === run.artifactId);
  const htmlRef = refs.find((r) => r.kind === "playwright-html");
  const autoOpen =
    own && htmlRef && own.state !== "expired"
      ? { artifactId: own.artifactId, path: htmlRef.path, title: htmlRef.name }
      : undefined;

  // A Playwright report opens by itself when the report changes; everything else waits for a click.
  useEffect(() => {
    setEmbed(Option.none());
    if (autoOpen) open({ ...autoOpen, inline: true });
  }, [run.reportId, autoOpen?.artifactId, autoOpen?.path]);

  if (artifacts.length === 0) return null;
  return (
    <Card pad={false} head="Original artifacts" meta={plural(artifacts.length, "artifact")}>
      <Space top={12}>
        <FigureGrid single>
          {artifacts.map((a) => {
            const isOwn = a.artifactId === run.artifactId;
            const links =
              isOwn && refs.length ? refs : [{ kind: "file", name: "index", path: "index.html" }];
            return (
              <FigureCell key={a.artifactId}>
                <K block>
                  <Ink>{a.name}</Ink> · {fmtBytes(a.sizeBytes)} · {a.state}
                  {a.expiresAt && ` · source expires ${fmtDay(a.expiresAt)}`}
                </K>
                <Space top={8}>
                  <Inline>
                    {a.state === "expired" ? (
                      <K tone="warn">expired at the source</K>
                    ) : (
                      links.map((l) => (
                        <Inline key={l.path}>
                          {(l.kind === "playwright-html" || l.kind === "file") && (
                            <Cmd
                              small
                              disabled={AsyncResult.isWaiting(opening)}
                              onClick={() =>
                                open({
                                  artifactId: a.artifactId,
                                  path: l.path,
                                  title: l.name,
                                  inline: true,
                                })
                              }
                            >
                              view {l.kind === "playwright-html" ? "report" : basename(l.path)}
                            </Cmd>
                          )}
                          <Cmd
                            small
                            onClick={() =>
                              open({
                                artifactId: a.artifactId,
                                path: l.path,
                                title: l.name,
                                inline: false,
                              })
                            }
                          >
                            {basename(l.path)} ↗
                          </Cmd>
                        </Inline>
                      ))
                    )}
                  </Inline>
                </Space>
              </FigureCell>
            );
          })}
        </FigureGrid>
      </Space>
    </Card>
  );
}

function EmbeddedArtifact() {
  const embed = useAtomValue(embedAtom);
  return Option.match(embed, {
    onNone: () => null,
    onSome: (e) => (
      <Section eyebrow="Original report">
        <Frame title={e.title} src={e.url} meta="served from TAG's artifact origin, sandboxed" />
      </Section>
    ),
  });
}
