# Report adapters

Adapters read files inside CI artifacts and emit CTRF. They check file contents,
not artifact names. The shared runner fills stable identities and adds known
artifact links. It tries CTRF first and skips the Playwright JSON fallback if any
CTRF report was found in that artifact.

## CTRF

`packages/adapters/src/ctrf.ts` reads JSON files with `results.tool`,
`results.summary` and a `results.tests` array. It validates the report, keeps its
fields, fills a missing run id and merges the CI environment. The CI timestamp
wins when known. Invalid CTRF-shaped files fail validation.

In a client repository, add a CTRF reporter and upload its JSON output. The
proposal's pytest path is `pip install pytest-json-ctrf`, then run pytest with
`--ctrf results.ctrf.json` and upload that file.

For Playwright, add `['playwright-ctrf-json-reporter', { outputDir: 'playwright-report' }]`
alongside the `html` reporter and upload `playwright-report/`. Install the reporter
in that repository. TAG can link the adjacent HTML report.

## JUnit

`packages/adapters/src/junit.ts` reads XML files whose first 2,000 characters
contain `<testsuite>` or `<testsuites>` (attributes are allowed). Each file becomes
one CTRF report. Test cases become tests; failure or error means failed, skipped
means skipped, and the rest pass. Durations change from seconds to milliseconds.
Suite names and class names form the suite path. File, line, failure messages,
traces, stdout and stderr are kept when present. The original XML gets an artifact
link. The tool is `pytest` for a single suite named pytest; otherwise it is `junit`.

Upload the JUnit XML your runner writes. For pytest's native XML path, run
`pytest --junitxml=results.xml` and upload `results.xml`. This is an alternative to
the proposal's pytest CTRF change above; no CTRF reporter is needed for XML.

## Playwright JSON fallback

`packages/adapters/src/playwright.ts` reads JSON with a `config` field and a
`suites` array. It does not parse the HTML report into test results. Enable the
Playwright JSON reporter with an output file and upload that file alongside the
HTML report, or use the proposal's CTRF reporter setup above.

Each spec/project pair with at least one result becomes a CTRF test. An overall
`unexpected` result fails; an overall `skipped` result skips. Otherwise a skipped
final attempt skips and the test passes. The adapter records flaky status, retries,
prior attempts and total attempt duration. It keeps suite paths, files, lines,
tags, project names as browsers, errors and file attachments. It links the JSON
and any detected HTML report. HTML detection looks for `playwright-report/index.html`,
or an `index.html` beside `trace/index.html`.

## DeepEval

`packages/adapters/src/deepeval.ts` reads `.latest_test_run.json` with a
`testRunData` wrapper, or JSON with `testCases` or `conversationalTestCases`.
It prefers `test_run_*.json` exports, then hidden latest files, then the first
other matching file. This avoids reading both export forms for the same run.

Cases become CTRF tests. Success passes; failure fails unless a metric error makes
it `other`. Seconds become milliseconds. Scores, thresholds, pass flags, reasons
and errors become `tag.metrics`. Hallucination, toxicity and bias metrics use
`<=` thresholds; other names use `>=`. Raw metric data, input/output, context,
costs and run metadata stay in extras. The JSON gets an artifact link.

In the client job, set `DEEPEVAL_RESULTS_FOLDER=deepeval-results` and upload that
directory, as the proposal specifies. Give each parallel job its own folder;
DeepEval's temp file is not safe across shards. If uploading the hidden latest
file instead, ensure the upload includes hidden files.

## Repository detection

`packages/app/src/scan.ts` reads `.github/workflows/*.yml` and `*.yaml`. It looks
for `run:` commands under jobs with two-space job keys. It handles inline commands
and indented block commands. This is a text scanner, not a full YAML parser; it
does not follow package scripts or reusable workflows.

It recognizes `cargo nextest`, `cargo test`, `go test`, `pytest`, `vitest`,
`playwright`, `jest`, `bun test`, `mocha` and `deepeval`. It keeps the first job and
command found for each runner. Config filenames can also signal Vitest, Jest,
Playwright, Mocha, Cargo, pytest or Go without a matching workflow command.

A recognized runner alone does not prove that CI uploads a report. Parsed reports
make a repository `reporting`. Otherwise unread artifact samples make it
`unsupported`; runners with no reports make it `needs-change`; neither makes it
`no-tests`. Samples can identify Mocha JSON, TAP and Go test JSON, but these four
adapters do not convert those formats.
