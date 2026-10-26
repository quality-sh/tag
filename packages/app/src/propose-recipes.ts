// What each test runner needs to write a report the adapters read: the flags, the environment,
// the package, and the file it lands in. Pure.
import type { Runner } from "./scan.ts";

export const LABEL: Record<Runner, string> = {
  vitest: "Vitest",
  jest: "Jest",
  "bun test": "bun test",
  playwright: "Playwright",
  mocha: "Mocha",
  "cargo test": "cargo test",
  nextest: "cargo nextest",
  pytest: "pytest",
  "go test": "go test",
  deepeval: "DeepEval",
};

export const SLUG: Record<Runner, string> = {
  vitest: "vitest",
  jest: "jest",
  "bun test": "bun",
  playwright: "playwright",
  mocha: "mocha",
  "cargo test": "cargo",
  nextest: "nextest",
  pytest: "pytest",
  "go test": "go",
  deepeval: "deepeval",
};

/** What one runner needs to write a report; `report` is relative to the step's directory. */
export interface Recipe {
  readonly report: string;
  readonly how: string;
  readonly flags?: string;
  readonly env?: ReadonlyArray<readonly [string, string]>;
  /** A directory the runner will not create itself. */
  readonly mkdir?: string;
  /** Text right after the runner's own words, as go test's `-v`. */
  readonly afterRunner?: string;
  /** Text after the flags, as go test's pipe into go-junit-report. */
  readonly pipe?: string;
  readonly packageName?: string;
  readonly nextestProfile?: string;
}

const GO_JUNIT_REPORT = "github.com/jstemmer/go-junit-report/v2@v2.1.0";

/** The junit path a nextest profile already sets in the config, if any. */
export const nextestJunitPath = (config: string | null, profile: string): string | null => {
  if (config === null) return null;
  const at = config.indexOf(`[profile.${profile}.junit]`);
  if (at < 0) return null;
  const section = config.slice(at).split(/\n\[/)[0] ?? "";
  return /^\s*path\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? "junit.xml";
};

/** How `runner` invoked by `segment` writes its report to `name`, or why it cannot. */
export const recipeFor = (
  runner: Runner,
  segment: string,
  name: string,
  nextestConfig: string | null,
): Recipe | string => {
  const xml = `test-results/${name}.xml`;
  if (/--reporters?\b|junit|ctrf/i.test(segment)) return "the command already picks its reporter";
  switch (runner) {
    case "vitest":
      return {
        report: xml,
        flags: `--reporter=default --reporter=junit --outputFile.junit=${xml}`,
        how: "Vitest's junit reporter beside its default one",
      };
    case "jest":
      return {
        report: xml,
        flags: "--reporters=default --reporters=jest-junit",
        env: [
          ["JEST_JUNIT_OUTPUT_DIR", "test-results"],
          ["JEST_JUNIT_OUTPUT_NAME", `${name}.xml`],
        ],
        packageName: "jest-junit",
        how: "the jest-junit reporter beside the default one",
      };
    case "bun test":
      return {
        report: xml,
        mkdir: "test-results",
        flags: `--reporter=junit --reporter-outfile=${xml}`,
        how: "bun's junit reporter",
      };
    case "playwright":
      return {
        report: xml,
        flags: "--reporter=html,junit",
        env: [["PLAYWRIGHT_JUNIT_OUTPUT_NAME", xml]],
        how: "Playwright's junit reporter beside the html one",
      };
    case "mocha":
      return {
        report: xml,
        flags: `--reporter mocha-junit-reporter --reporter-options mochaFile=${xml}`,
        packageName: "mocha-junit-reporter",
        how: "the mocha-junit-reporter reporter",
      };
    case "pytest":
      return { report: xml, flags: `--junitxml=${xml}`, how: "pytest's own --junitxml" };
    case "go test": {
      const json = /\s-json\b/.test(segment);
      const verbose = json || /\s-v\b/.test(segment);
      return {
        report: xml,
        mkdir: "test-results",
        ...(verbose ? {} : { afterRunner: " -v" }),
        pipe: ` 2>&1 | go run ${GO_JUNIT_REPORT} -set-exit-code -iocopy${json ? " -parser gojson" : ""} -out ${xml}`,
        how: "go-junit-report, run with go run so nothing is installed",
      };
    }
    case "nextest": {
      const named = /--profile[=\s]+([\w-]+)/.exec(segment)?.[1];
      const profile = named ?? "ci";
      const file = nextestJunitPath(nextestConfig, profile) ?? "junit.xml";
      return {
        report: `target/nextest/${profile}/${file}`,
        ...(named ? {} : { flags: "--profile ci" }),
        nextestProfile: profile,
        how: `nextest's JUnit output for the ${profile} profile`,
      };
    }
    case "deepeval": {
      const folder = name.replace("deepeval", "deepeval-results");
      return {
        report: `${folder}/`,
        env: [["DEEPEVAL_RESULTS_FOLDER", folder]],
        how: "DeepEval's results folder",
      };
    }
    case "cargo test":
      return "cargo test writes no JUnit; switch the job to cargo nextest, which can";
  }
};

/** Words before the runner's own that make the command an install, not a test run. */
const CHORES = new Set(["install", "add", "i", "ci", "get", "uninstall", "remove"]);
/** Playwright's own commands that run no tests. */
const PLAYWRIGHT_CHORES = new Set(["install", "show-report", "merge-reports", "codegen"]);

export const runsTests = (runner: Runner, segment: string, at: number) => {
  if (
    segment
      .slice(0, at)
      .trim()
      .split(/\s+/)
      .some((w) => CHORES.has(w))
  )
    return false;
  const next = segment.slice(at).trim().split(/\s+/)[1] ?? "";
  if (runner === "playwright" && PLAYWRIGHT_CHORES.has(next)) return false;
  if (runner === "deepeval") return /\bdeepeval\s+test\s+run\b/.test(segment);
  return true;
};
