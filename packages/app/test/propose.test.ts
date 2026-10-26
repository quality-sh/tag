// The CI proposal generator over the fixtures-scan workflows: the lines it inserts, and every
// other line left exactly as it was.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { detectRunners } from "../src/scan.ts";
import { NEXTEST_CONFIG, proposeChange, type Proposal } from "../src/propose.ts";

const SCAN_FIXTURES = new URL("../../../fixtures-scan/acme/", import.meta.url).pathname;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) =>
    statSync(join(dir, e)).isDirectory() ? walk(join(dir, e)) : [join(dir, e)],
  );

/** A fixture repository's tree, scanned as the ingest pass scans it, then proposed. */
const proposalFor = (repo: string) => {
  const root = join(SCAN_FIXTURES, repo, "tree");
  const paths = walk(root).map((p) => relative(root, p));
  const files = paths.map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const runners = detectRunners({ paths, files });
  return { files, proposal: proposeChange({ runners, files }) };
};

const fileOf = (p: Proposal, path: string) => {
  const f = p.files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no change to ${path}`);
  return f;
};

/** Longest common subsequence of two line lists, as the indexes each side keeps. */
const common = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const keptA = new Set<number>();
  const keptB = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      keptA.add(i++);
      keptB.add(j++);
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
    else j++;
  }
  return { keptA, keptB };
};

const isSubsequence = (small: string, big: string) => {
  let i = 0;
  for (const c of big) if (c === small[i]) i++;
  return i === small.length;
};

/**
 * Everything but the edit is byte-identical: every old line survives in order, and each one
 * the change rewrote comes back with text only added to it. Returns the lines it added.
 */
const expectOnlyAdditions = (before: string, after: string) => {
  const a = before.split("\n");
  const b = after.split("\n");
  const { keptA, keptB } = common(a, b);
  const added = b.filter((_, j) => !keptB.has(j));
  const rewritten = a.filter((_, i) => !keptA.has(i));
  for (const old of rewritten) expect(added.some((line) => isSubsequence(old, line))).toBe(true);
  return { added, rewritten };
};

describe("proposeChange over fixtures-scan", () => {
  test("workflow-only: Vitest and Playwright each write JUnit and upload it after their step", () => {
    const { files, proposal } = proposalFor("workflow-only");
    const ci = fileOf(proposal, ".github/workflows/ci.yml");
    expect(ci.before).toBe(files[0]?.text ?? "");
    const { added, rewritten } = expectOnlyAdditions(ci.before ?? "", ci.after);
    expect(rewritten).toEqual(["      - run: pnpm vitest run", "      - run: npx playwright test"]);
    expect(added).toContain(
      "      - run: pnpm vitest run --reporter=default --reporter=junit --outputFile.junit=test-results/vitest.xml",
    );
    expect(added).toContain("      - run: npx playwright test --reporter=html,junit");
    expect(added).toContain("          PLAYWRIGHT_JUNIT_OUTPUT_NAME: test-results/playwright.xml");
    expect(added.filter((l) => l === "        if: always()")).toHaveLength(2);
    expect(added.filter((l) => l === "        uses: actions/upload-artifact@v4")).toHaveLength(2);
    expect(proposal.uploads.map((u) => [u.runner, u.artifact, u.report])).toEqual([
      ["vitest", "test-results-vitest", "test-results/vitest.xml"],
      ["playwright", "test-results-playwright", "test-results/playwright.xml"],
    ]);
    expect(proposal.notes).toEqual([]);
    expect(proposal.description).toContain("Vitest writes test-results/vitest.xml");
  });

  test("nextest-matrix: reproduces provenance's change, the junit profile and the matrix name", () => {
    const { proposal } = proposalFor("nextest-matrix");
    const ci = fileOf(proposal, ".github/workflows/ci.yml");
    expect(ci.diff).toBe(`--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -20,9 +20,18 @@
         uses: taiki-e/install-action@c3ec0de9ae7f1019cea21aa96aa0a895b9552063 # v2
         with:
           tool: nextest@0.9.143
+      # The report this step writes feeds TAG, the test aggregator.
       - name: Test concurrently
         if: runner.os != 'Linux'
         run: cargo nextest run --profile ci --workspace --all-features --no-fail-fast --cargo-profile test --timings
+      - name: Save the cargo nextest report
+        if: always()
+        uses: actions/upload-artifact@v4
+        with:
+          name: test-results-nextest-\${{ matrix.os }}
+          path: target/nextest/ci/junit.xml
+          if-no-files-found: warn
+          retention-days: 30
       - name: Test documentation
         run: cargo test --workspace --all-features --doc --no-fail-fast
       - name: Save Cargo timing reports
`);
    expectOnlyAdditions(ci.before ?? "", ci.after);
    const config = fileOf(proposal, NEXTEST_CONFIG);
    expect(config.after).toBe(
      `${config.before}
[profile.ci.junit]
# target/nextest/ci/junit.xml; CI uploads it for TAG, the test aggregator.
path = "junit.xml"
`,
    );
    expect(proposal.notes).toEqual([
      "cargo test in job test is left alone: cargo test writes no JUnit; switch the job to cargo nextest, which can.",
    ]);
  });

  test("bun-suite: bun test makes its directory and writes JUnit, as hyperstition's did", () => {
    const { proposal } = proposalFor("bun-suite");
    const ci = fileOf(proposal, ".github/workflows/ci.yml");
    const { added, rewritten } = expectOnlyAdditions(ci.before ?? "", ci.after);
    expect(rewritten).toEqual(["        run: bun test --coverage"]);
    expect(added).toEqual([
      "      # The report this step writes feeds TAG, the test aggregator.",
      "        run: mkdir -p test-results && bun test --coverage --reporter=junit --reporter-outfile=test-results/bun.xml",
      "      - name: Save the bun test report",
      "        if: always()",
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: test-results-bun",
      "          path: test-results/bun.xml",
      "          if-no-files-found: warn",
      "          retention-days: 30",
    ]);
  });

  test("web-suite: Vitest and Playwright across two workflows; the install step is not a run", () => {
    const { proposal } = proposalFor("web-suite");
    expect(proposal.files.map((f) => f.path)).toEqual([
      ".github/workflows/deploy.yml",
      ".github/workflows/review-assets.yml",
    ]);
    const deploy = fileOf(proposal, ".github/workflows/deploy.yml");
    expect(expectOnlyAdditions(deploy.before ?? "", deploy.after).rewritten).toEqual([
      "      - run: pnpm exec vitest run",
    ]);
    const review = fileOf(proposal, ".github/workflows/review-assets.yml");
    const { added, rewritten } = expectOnlyAdditions(review.before ?? "", review.after);
    expect(rewritten).toEqual([
      "      - run: pnpm build:review-fixture && pnpm exec playwright test",
    ]);
    expect(added.slice(0, 4)).toEqual([
      "      # The report this step writes feeds TAG, the test aggregator.",
      "      - run: pnpm build:review-fixture && pnpm exec playwright test --reporter=html,junit",
      "        env:",
      "          PLAYWRIGHT_JUNIT_OUTPUT_NAME: test-results/playwright.xml",
    ]);
    expect(review.after).toContain(
      "      - run: pnpm exec playwright install --with-deps chromium\n",
    );
  });

  test("polyglot: pytest, DeepEval, go test, Jest and Mocha, with packages and the job names", () => {
    const { proposal } = proposalFor("polyglot");
    const tests = fileOf(proposal, ".github/workflows/tests.yml");
    const { added, rewritten } = expectOnlyAdditions(tests.before ?? "", tests.after);
    expect(rewritten).toEqual([
      "            -q tests/unit",
      "      - run: go vet ./... && go test -race ./...",
      "      - run: npm ci",
      "        run: npx jest --ci",
      "      - run: npm run mocha:unit",
      '      - run: "yarn mocha test/legacy"',
    ]);
    expect(added).toContain("            -q tests/unit --junitxml=test-results/pytest.xml");
    expect(added).toContain("          DEEPEVAL_RESULTS_FOLDER: deepeval-results");
    expect(added).toContain(
      "      - run: go vet ./... && mkdir -p test-results && go test -v -race ./... 2>&1 | go run github.com/jstemmer/go-junit-report/v2@v2.1.0 -set-exit-code -iocopy -out test-results/go.xml",
    );
    expect(added).toContain(
      "      - run: npm ci && npm install --no-save jest-junit mocha-junit-reporter",
    );
    expect(added).toContain("          JEST_JUNIT_OUTPUT_NAME: jest.xml");
    expect(added).toContain(
      "      - run: npm run mocha:unit -- --reporter mocha-junit-reporter --reporter-options mochaFile=test-results/mocha.xml",
    );
    expect(added).toContain(
      '      - run: "yarn mocha test/legacy --reporter mocha-junit-reporter --reporter-options mochaFile=test-results/mocha.xml"',
    );
    expect(proposal.uploads.map((u) => [u.job, u.artifact, u.report])).toEqual([
      ["python", "test-results-pytest-${{ matrix.python }}", "test-results/pytest.xml"],
      ["python", "test-results-deepeval-${{ matrix.python }}", "deepeval-results/"],
      ["go", "test-results-go", "test-results/go.xml"],
      ["web", "test-results-jest", "web/test-results/jest.xml"],
      ["web", "test-results-mocha-web", "test-results/mocha.xml"],
      ["legacy", "test-results-mocha-legacy", "test-results/mocha.xml"],
    ]);
    expect(proposal.packages).toEqual(["jest-junit", "mocha-junit-reporter"]);
    expect(proposal.notes).toEqual([
      "Job legacy in .github/workflows/tests.yml needs mocha-junit-reporter, and its install step is not a plain npm ci or bun install line, so this change does not add it. Add it to the dev dependencies.",
    ]);
    expect(proposal.description).toContain(
      "The reporters need jest-junit and mocha-junit-reporter.",
    );
  });
});

const workflow = (steps: string, head = "") => ({
  path: ".github/workflows/ci.yml",
  text: `on: push\njobs:\n  test:\n${head}    runs-on: ubuntu-latest\n    steps:\n${steps}`,
});

const propose = (
  runners: ReadonlyArray<[string, string | null]>,
  files: ReadonlyArray<{ path: string; text: string }>,
) =>
  proposeChange({
    runners: runners.map(([runner, job]) => ({
      runner: runner as Parameters<typeof proposeChange>[0]["runners"][number]["runner"],
      job,
      command: null,
    })),
    files,
  });

describe("proposeChange edge cases", () => {
  test("keeps CRLF line ends and adds its lines with them", () => {
    const text = "jobs:\r\n  test:\r\n    steps:\r\n      - run: pytest\r\n";
    const p = propose([["pytest", "test"]], [{ path: ".github/workflows/ci.yml", text }]);
    const after = p.files[0]?.after ?? "";
    expect(after.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true);
    expect(after).toContain("      - run: pytest --junitxml=test-results/pytest.xml\r\n");
  });

  test("changes nothing for a runner found only in config, and says so", () => {
    const p = propose([["vitest", null]], [workflow("      - run: pnpm test\n")]);
    expect(p.files).toEqual([]);
    expect(p.notes).toEqual([
      "Vitest shows in the repository's config, but no workflow step runs it by name, so this change does not touch it.",
    ]);
  });

  test("leaves a command alone that already picks its reporter or clashes with the step's env", () => {
    const p = propose(
      [
        ["vitest", "test"],
        ["playwright", "test"],
        ["jest", "test"],
      ],
      [
        workflow(`      - run: npx vitest run --reporter=junit
      - run: npx playwright test
        env:
          PLAYWRIGHT_JUNIT_OUTPUT_NAME: out.xml
      - run: npx jest
        env: { CI: "true" }
`),
      ],
    );
    expect(p.files).toEqual([]);
    expect(p.notes).toEqual([
      "Vitest in job test is left alone: the command already picks its reporter.",
      "Playwright in job test is left alone: the step already sets PLAYWRIGHT_JUNIT_OUTPUT_NAME.",
      "Jest in job test is left alone: the step's env is a flow map this change does not edit.",
    ]);
  });

  test("puts flags before a bare --, after a \\ continuation, and numbers a runner's second run", () => {
    const p = propose(
      [["pytest", "test"]],
      [
        workflow(`      - run: pytest tests/a -- -x
      - run: |
          pytest \\
            tests/b && echo done
`),
      ],
    );
    const after = p.files[0]?.after ?? "";
    expect(after).toContain("- run: pytest tests/a --junitxml=test-results/pytest.xml -- -x\n");
    expect(after).toContain("tests/b --junitxml=test-results/pytest-2.xml && echo done\n");
    expect(p.uploads.map((u) => u.artifact)).toEqual([
      "test-results-pytest-test",
      "test-results-pytest-test-2",
    ]);
  });

  test("a computed matrix nobody reads names artifacts by job index", () => {
    const p = propose(
      [["go test", "test"]],
      [
        workflow(
          "      - run: go test -json ./...\n",
          "    strategy:\n      matrix: ${{ fromJSON(inputs.matrix) }}\n",
        ),
      ],
    );
    expect(p.uploads[0]?.artifact).toBe("test-results-go-${{ strategy.job-index }}");
    expect(p.files[0]?.after).toContain(
      "go test -json ./... 2>&1 | go run github.com/jstemmer/go-junit-report/v2@v2.1.0 -set-exit-code -iocopy -parser gojson -out test-results/go.xml",
    );
  });

  test("bun install gains the package; a missing nextest config is created", () => {
    const p = propose(
      [
        ["jest", "test"],
        ["nextest", "test"],
      ],
      [
        workflow(`      - run: bun install
      - run: bunx jest
      - run: cargo nextest run --profile ci
`),
      ],
    );
    expect(p.files[0]?.after).toContain("- run: bun install && bun add --no-save jest-junit\n");
    const config = p.files.find((f) => f.path === NEXTEST_CONFIG);
    expect(config?.before).toBeNull();
    expect(config?.diff).toStartWith(
      "--- /dev/null\n+++ b/.config/nextest.toml\n@@ -0,0 +1,3 @@\n",
    );
  });

  test("a nextest profile whose junit path is set is read, not rewritten", () => {
    const p = propose(
      [["nextest", "test"]],
      [
        workflow("      - run: cargo nextest run --profile ci\n"),
        { path: NEXTEST_CONFIG, text: '[profile.ci.junit]\npath = "report.xml"' },
      ],
    );
    expect(p.files.map((f) => f.path)).toEqual([".github/workflows/ci.yml"]);
    expect(p.uploads[0]?.report).toBe("target/nextest/ci/report.xml");
  });

  test("an npm script run gets -- before the flags; deepeval without test run is left alone", () => {
    const p = propose(
      [
        ["vitest", "test"],
        ["deepeval", "test"],
      ],
      [workflow("      - run: npm run vitest:unit\n      - run: deepeval login\n")],
    );
    expect(p.files[0]?.after).toContain(
      "- run: npm run vitest:unit -- --reporter=default --reporter=junit --outputFile.junit=test-results/vitest.xml\n",
    );
    expect(p.notes).toEqual([
      "DeepEval in job test is left alone: no step runs its tests by name.",
    ]);
  });
});
