import { describe, expect, test } from "bun:test";
import {
  classifyRepository,
  detectRunners,
  jobCommands,
  sniffSample,
  type Runner,
  type RunnerFinding,
  type UnreadArtifact,
} from "../src/scan.ts";

const ci = (steps: string) => [
  {
    path: ".github/workflows/ci.yml",
    text: `jobs:
  Tests:
    runs-on: ubuntu-latest
    steps:
${steps}`,
  },
];

describe("detectRunners", () => {
  test("names both runners and the job when one workflow runs vitest and playwright", () => {
    const runners = detectRunners({
      paths: ["vitest.config.ts", "playwright.config.ts", ".github/workflows/ci.yml"],
      files: ci(`      - uses: actions/checkout@v4
      - run: pnpm vitest run
      - run: npx playwright test`),
    });
    expect(runners).toEqual([
      { runner: "playwright", job: "Tests", command: "npx playwright test" },
      { runner: "vitest", job: "Tests", command: "pnpm vitest run" },
    ]);
  });

  test("reads a block scalar run step", () => {
    const runners = detectRunners({
      paths: [],
      files: ci(`      - name: tests
        run: |
          bun install
          bun test`),
    });
    expect(runners).toEqual([
      { runner: "bun test", job: "Tests", command: "bun install\nbun test" },
    ]);
  });

  test("tells nextest from cargo test and reads several jobs", () => {
    const runners = detectRunners({
      paths: [],
      files: [
        {
          path: ".github/workflows/rust.yml",
          text: `jobs:
  Next:
    steps:
      - run: cargo nextest run
  Plain:
    steps:
      - run: cargo test`,
        },
      ],
    });
    expect(runners).toEqual([
      { runner: "cargo test", job: "Plain", command: "cargo test" },
      { runner: "nextest", job: "Next", command: "cargo nextest run" },
    ]);
  });

  test("names the runner from its config file when no workflow runs it", () => {
    const table: ReadonlyArray<readonly [path: string, runner: Runner]> = [
      ["vitest.config.ts", "vitest"],
      ["jest.config.cjs", "jest"],
      ["playwright.config.mts", "playwright"],
      [".mocharc.yml", "mocha"],
      ["Cargo.toml", "cargo test"],
      ["pytest.ini", "pytest"],
      ["pyproject.toml", "pytest"],
      ["go.mod", "go test"],
    ];
    for (const [path, runner] of table)
      expect(detectRunners({ paths: [path], files: [] })).toEqual([
        { runner, job: null, command: null },
      ]);
  });

  test("prefers the workflow's job and command over the bare config finding", () => {
    const runners = detectRunners({
      paths: ["go.mod"],
      files: ci("      - run: go test ./..."),
    });
    expect(runners).toEqual([{ runner: "go test", job: "Tests", command: "go test ./..." }]);
  });

  test("stops reading jobs when the document leaves them", () => {
    const runners = detectRunners({
      paths: [],
      files: [
        {
          path: ".github/workflows/ci.yml",
          text: `name: ci
on: push
jobs:
  Tests:
    steps:
      - run: bun test
`,
        },
      ],
    });
    expect(runners).toEqual([{ runner: "bun test", job: "Tests", command: "bun test" }]);
  });
});

describe("jobCommands", () => {
  test("keeps the command text after run:", () => {
    expect(jobCommands("jobs:\n  A:\n    steps:\n      - run: pnpm vitest --coverage\n")).toEqual([
      ["A", "pnpm vitest --coverage"],
    ]);
  });
});

describe("sniffSample", () => {
  test("knows mocha's JSON reporter output", () => {
    const text = JSON.stringify({
      stats: { suites: 1, tests: 2, passes: 1, failures: 1 },
      tests: [{ title: "a" }],
      failures: [{ title: "b" }],
    });
    expect(sniffSample([{ path: "mocha.json", text }])).toBe("mocha-json");
  });

  test("knows TAP", () => {
    expect(sniffSample([{ path: "out.tap", text: "TAP version 13\n1..1\nok 1 a\n" }])).toBe("tap");
    expect(sniffSample([{ path: "out.tap", text: "1..1\nnot ok 1 a\n" }])).toBe("tap");
  });

  test("knows go test JSON", () => {
    const text = `{"Time":"2026-10-25T10:00:00Z","Action":"run","Package":"x","Test":"TestA"}\n`;
    expect(sniffSample([{ path: "go.json", text }])).toBe("go-test-json");
  });

  test("calls text in no known shape unknown and an empty sample nothing", () => {
    expect(sniffSample([{ path: "a.txt", text: "hello" }])).toBe("unknown");
    expect(sniffSample([{ path: "a.txt", text: "" }])).toBe(null);
    expect(sniffSample([])).toBe(null);
  });

  test("does not call a junit sample unread", () => {
    const text = `<?xml version="1.0"?><testsuites><testsuite name="s"><testcase name="t"/></testsuite></testsuites>`;
    expect(sniffSample([{ path: "junit.xml", text }])).toBe("unknown");
  });
});

const finding = (runner: RunnerFinding["runner"]): RunnerFinding => ({
  runner,
  job: "Tests",
  command: null,
});
const unread = (format: UnreadArtifact["format"]): UnreadArtifact => ({
  name: "test-output",
  format,
});

describe("classifyRepository", () => {
  test("reports when a sample produced a report, whatever the name holds", () => {
    expect(
      classifyRepository({
        reporting: ["test-results-ubuntu-latest"],
        unread: [],
        runners: [finding("nextest")],
      }),
    ).toBe("reporting");
  });

  test("puts unread test output ahead of runners: the fix is an adapter, not a CI change", () => {
    const table: ReadonlyArray<UnreadArtifact["format"]> = ["mocha-json", "tap", "go-test-json"];
    for (const format of table)
      expect(
        classifyRepository({
          reporting: [],
          unread: [unread(format)],
          runners: [finding("vitest")],
        }),
      ).toBe("unsupported");
  });

  test("asks for a CI change when runners run but nothing reaches TAG", () => {
    expect(
      classifyRepository({
        reporting: [],
        unread: [],
        runners: [finding("vitest"), finding("playwright")],
      }),
    ).toBe("needs-change");
  });

  test("says no-tests when the scan finds nothing", () => {
    expect(classifyRepository({ reporting: [], unread: [], runners: [] })).toBe("no-tests");
  });
});
