// The CI change a needs-change repository should make, from its scan and its workflow texts:
// each test step writes a report the adapters read, and a new step right after it uploads
// that report even when the tests fail. Line edits only, so the rest stays byte-identical. Pure.
import { RUN_COMMANDS, type Runner, type RunnerFinding } from "./scan.ts";
import {
  LABEL,
  SLUG,
  nextestJunitPath,
  recipeFor,
  runsTests,
  type Recipe,
} from "./propose-recipes.ts";
import { applyEdits, createdDiff, splitLines, unifiedDiff, type LineEdit } from "./propose-diff.ts";
import { readJobs, type CommandLine, type Job, type Step } from "./propose-workflow.ts";

export const PROPOSAL_TITLE = "Upload test reports for TAG";
export const NEXTEST_CONFIG = ".config/nextest.toml";

export interface FileChange {
  readonly path: string;
  /** The text on the default branch; null for a file the change creates. */
  readonly before: string | null;
  readonly after: string;
  readonly diff: string;
}

export interface Upload {
  readonly workflow: string;
  readonly job: string;
  readonly runner: Runner;
  readonly report: string;
  readonly artifact: string;
  readonly how: string;
}

export interface Proposal {
  readonly files: ReadonlyArray<FileChange>;
  readonly uploads: ReadonlyArray<Upload>;
  /** Packages a reporter needs, which the repository should add to its dev dependencies. */
  readonly packages: ReadonlyArray<string>;
  /** What the change leaves alone and why, for the description. */
  readonly notes: ReadonlyArray<string>;
  readonly description: string;
}

/** Shell command boundaries in [from, to): `&&`, `||`, `;`, `|`; a ` #` ends the command. */
const segments = (text: string, from: number, to: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  const re = /&&|\|\||;|\||\s#/g;
  const body = text.slice(from, to);
  let start = 0;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    out.push([from + start, from + m.index]);
    if (m[0].endsWith("#")) return out;
    start = m.index + m[0].length;
  }
  out.push([from + start, to]);
  return out;
};

interface Invocation {
  readonly job: Job;
  readonly step: Step;
  readonly runner: Runner;
  readonly recipe: Recipe;
  readonly line: number;
  readonly start: number;
  /** Right after the runner's words. */
  readonly runnerEnd: number;
  /** Where the flags go: a line and a column. */
  readonly flagsAt: { readonly line: number; readonly at: number };
  readonly npmRun: boolean;
}

/** Where the flags go: the command's end, before a bare `--`, or past `\` continuations. */
const flagsPosition = (
  lines: ReadonlyArray<string>,
  run: ReadonlyArray<CommandLine>,
  index: number,
  start: number,
  end: number,
  npmRun: boolean,
) => {
  const command = run[index];
  const text = lines[command?.line ?? 0] ?? "";
  let line = command?.line ?? 0;
  let at = end;
  while (at > start && /\s/.test(text[at - 1] ?? "")) at--;
  if (end === command?.to && text.slice(start, at).endsWith("\\")) {
    let next = index + 1;
    while (next < run.length && (lines[run[next]?.line ?? 0] ?? "").trimEnd().endsWith("\\"))
      next++;
    const last = run[next];
    if (last !== undefined) {
      const lastText = lines[last.line] ?? "";
      const [first] = segments(lastText, last.from, last.to);
      line = last.line;
      at = first?.[1] ?? last.to;
      while (at > last.from && /\s/.test(lastText[at - 1] ?? "")) at--;
      return { line, at };
    }
  }
  const dashes = npmRun ? -1 : text.slice(start, at).indexOf(" -- ");
  return { line, at: dashes >= 0 ? start + dashes : at };
};

const findInvocations = (
  lines: ReadonlyArray<string>,
  jobs: ReadonlyArray<Job>,
  wanted: ReadonlySet<Runner>,
  nextestConfig: string | null,
  skipped: Map<Runner, string>,
): Invocation[] => {
  const out: Invocation[] = [];
  for (const job of jobs) {
    const seen = new Map<Runner, number>();
    for (const step of job.steps) {
      const taken = new Set<Runner>();
      step.run.forEach((command, index) => {
        const text = lines[command.line] ?? "";
        for (const [start, end] of segments(text, command.from, command.to)) {
          const segment = text.slice(start, end);
          const hit = RUN_COMMANDS.find(
            ([runner, re]) => wanted.has(runner) && !taken.has(runner) && re.test(segment),
          );
          if (!hit) continue;
          const [runner, re] = hit;
          const match = re.exec(segment);
          if (!runsTests(runner, segment, match?.index ?? 0)) continue;
          const count = (seen.get(runner) ?? 0) + 1;
          const recipe = recipeFor(
            runner,
            segment,
            count === 1 ? SLUG[runner] : `${SLUG[runner]}-${count}`,
            nextestConfig,
          );
          const clash = typeof recipe === "string" ? undefined : clashingEnv(step, recipe);
          if (typeof recipe === "string" || clash !== undefined) {
            skipped.set(runner, typeof recipe === "string" ? recipe : (clash ?? ""));
            continue;
          }
          seen.set(runner, count);
          taken.add(runner);
          const npmRun = /^\s*npm\s+(?:run(?:-script)?|test|t)\b/.test(segment);
          out.push({
            job,
            step,
            runner,
            recipe,
            line: command.line,
            start: start + (segment.length - segment.trimStart().length),
            runnerEnd: start + (match ? match.index + match[0].length : 0),
            flagsAt: flagsPosition(lines, step.run, index, start, end, npmRun),
            npmRun: npmRun && !segment.includes(" -- "),
          });
        }
      });
    }
  }
  return out;
};

/** Why the step's own env stops the recipe, if it does. */
const clashingEnv = (step: Step, recipe: Recipe): string | undefined => {
  if (!recipe.env || step.env === null) return undefined;
  if (step.env.childIndent < 0) return "the step's env is a flow map this change does not edit";
  const set = recipe.env.find(([name]) => step.env?.names.includes(name));
  return set ? `the step already sets ${set[0]}` : undefined;
};

const matrixSuffix = (job: Job) =>
  job.matrix === null
    ? ""
    : job.matrix.length === 0
      ? "-${{ strategy.job-index }}"
      : job.matrix.map((k) => `-\${{ matrix.${k} }}`).join("");

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Artifact names unique within one workflow run: the job joins the name when it must. */
const artifactNames = (invocations: ReadonlyArray<Invocation>) => {
  const base = (i: Invocation) => `test-results-${SLUG[i.runner]}`;
  const counts = new Map<string, number>();
  for (const i of invocations) counts.set(base(i), (counts.get(base(i)) ?? 0) + 1);
  const used = new Map<string, number>();
  return invocations.map((i) => {
    const plain = (counts.get(base(i)) ?? 0) > 1 ? `${base(i)}-${slugOf(i.job.id)}` : base(i);
    const n = (used.get(plain) ?? 0) + 1;
    used.set(plain, n);
    return `${n === 1 ? plain : `${plain}-${n}`}${matrixSuffix(i.job)}`;
  });
};

const pad = (n: number) => " ".repeat(n);

const uploadStep = (step: Step, label: string, artifact: string, path: string) => {
  const dash = pad(step.dashIndent);
  const key = pad(step.dashIndent + Math.max(2, step.keyIndent - step.dashIndent));
  const inner = pad(step.dashIndent + 2 * Math.max(2, step.keyIndent - step.dashIndent));
  return [
    `${dash}- name: Save the ${label} report`,
    `${key}if: always()`,
    `${key}uses: actions/upload-artifact@v4`,
    `${key}with:`,
    `${inner}name: ${artifact}`,
    `${inner}path: ${path}`,
    `${inner}if-no-files-found: warn`,
    `${inner}retention-days: 30`,
  ];
};

const PLAIN_INSTALL = /^(npm ci|npm install|bun install)(?:\s+--?[\w-]+(?:=\S+)?)*$/;

/** One workflow's edits, the uploads they add, and the packages and notes they leave. */
const proposeWorkflow = (
  path: string,
  text: string,
  wanted: ReadonlySet<Runner>,
  nextestConfig: string | null,
  skipped: Map<Runner, string>,
) => {
  const { lines } = splitLines(text);
  const jobs = readJobs(lines);
  const invocations = findInvocations(lines, jobs, wanted, nextestConfig, skipped);
  const names = artifactNames(invocations);
  const edits = new Map<number, { before: string[]; after: string[] }>();
  const inserts = new Map<number, Array<{ at: number; text: string }>>();
  const edit = (line: number) => {
    const e = edits.get(line) ?? { before: [], after: [] };
    edits.set(line, e);
    return e;
  };
  const insert = (line: number, at: number, t: string) =>
    inserts.set(line, [...(inserts.get(line) ?? []), { at, text: t }]);
  const uploads: Upload[] = [];
  const notes: string[] = [];
  const packages = new Map<Job, Set<string>>();
  const steps = new Map<Step, Invocation[]>();
  invocations.forEach((inv) => steps.set(inv.step, [...(steps.get(inv.step) ?? []), inv]));
  for (const [step, list] of steps) {
    edit(step.start).before.push(
      `${pad(step.dashIndent)}# The report this step writes feeds TAG, the test aggregator.`,
    );
    const newEnv: string[] = [];
    const after: string[] = [];
    for (const inv of list) {
      const { recipe } = inv;
      if (recipe.mkdir) insert(inv.line, inv.start, `mkdir -p ${recipe.mkdir} && `);
      if (recipe.afterRunner) insert(inv.line, inv.runnerEnd, recipe.afterRunner);
      const flags = `${inv.npmRun ? " --" : ""}${recipe.flags ? ` ${recipe.flags}` : ""}${recipe.pipe ?? ""}`;
      if (flags) insert(inv.flagsAt.line, inv.flagsAt.at, flags);
      for (const [name, value] of recipe.env ?? []) {
        if (step.env !== null)
          edit(step.env.line).after.push(`${pad(step.env.childIndent)}${name}: ${value}`);
        else newEnv.push(`${pad(step.keyIndent + 2)}${name}: ${value}`);
      }
      if (recipe.packageName)
        packages.set(inv.job, (packages.get(inv.job) ?? new Set()).add(recipe.packageName));
      const dir = step.workingDirectory?.replace(/^\.\/?/, "").replace(/\/$/, "");
      const report = dir ? `${dir}/${recipe.report}` : recipe.report;
      const artifact = names[invocations.indexOf(inv)] ?? `test-results-${SLUG[inv.runner]}`;
      after.push(...uploadStep(step, LABEL[inv.runner], artifact, report));
      uploads.push({
        workflow: path,
        job: inv.job.id,
        runner: inv.runner,
        report,
        artifact,
        how: recipe.how,
      });
    }
    if (newEnv.length > 0) edit(step.last).after.push(`${pad(step.keyIndent)}env:`, ...newEnv);
    edit(step.last).after.push(...after);
  }
  for (const [job, names] of packages) {
    const list = [...names].sort().join(" ");
    const first = invocations.find((i) => i.job === job)?.step;
    const install = job.steps
      .slice(0, first ? job.steps.indexOf(first) : job.steps.length)
      .find((s) => {
        const c = s.run[0];
        return (
          s.run.length === 1 &&
          c !== undefined &&
          PLAIN_INSTALL.test((lines[c.line] ?? "").slice(c.from, c.to))
        );
      });
    const command = install?.run[0];
    if (command === undefined) {
      notes.push(
        `Job ${job.id} in ${path} needs ${list}, and its install step is not a plain npm ci or bun install line, so this change does not add it. Add it to the dev dependencies.`,
      );
      continue;
    }
    const npm = (lines[command.line] ?? "").slice(command.from).startsWith("npm");
    insert(
      command.line,
      command.to,
      npm ? ` && npm install --no-save ${list}` : ` && bun add --no-save ${list}`,
    );
  }
  const lineEdits = new Map<number, LineEdit>();
  for (const [line, e] of edits) lineEdits.set(line, e);
  for (const [line, list] of inserts) {
    let t = lines[line] ?? "";
    for (const ins of [...list].sort((a, b) => b.at - a.at))
      t = t.slice(0, ins.at) + ins.text + t.slice(ins.at);
    lineEdits.set(line, { ...(edits.get(line) ?? { before: [], after: [] }), replace: t });
  }
  const profiles = new Set(
    invocations.flatMap((i) => (i.recipe.nextestProfile ? [i.recipe.nextestProfile] : [])),
  );
  return {
    change:
      lineEdits.size === 0
        ? null
        : {
            path,
            before: text,
            after: applyEdits(text, lineEdits),
            diff: unifiedDiff(path, text, lineEdits),
          },
    uploads,
    packages: [...packages.values()].flatMap((s) => [...s]),
    notes,
    profiles,
  };
};

/** The nextest config with a junit section for each profile that lacks one. */
const nextestChange = (config: string | null, profiles: ReadonlySet<string>): FileChange | null => {
  const missing = [...profiles].filter((p) => nextestJunitPath(config, p) === null).sort();
  if (missing.length === 0) return null;
  const sections = missing.flatMap((p) => [
    `[profile.${p}.junit]`,
    `# target/nextest/${p}/junit.xml; CI uploads it for TAG, the test aggregator.`,
    `path = "junit.xml"`,
  ]);
  if (config === null) {
    const after = sections.join("\n") + "\n";
    return { path: NEXTEST_CONFIG, before: null, after, diff: createdDiff(NEXTEST_CONFIG, after) };
  }
  const { lines } = splitLines(config);
  const edits = new Map<number, LineEdit>([
    [lines.length - 1, { before: [], after: ["", ...sections] }],
  ]);
  const base = config.endsWith("\n") || config === "" ? config : `${config}\n`;
  return {
    path: NEXTEST_CONFIG,
    before: config,
    after: applyEdits(base, edits),
    diff: unifiedDiff(NEXTEST_CONFIG, base, edits),
  };
};

const isWorkflow = (path: string) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

/** The whole change: every workflow's edits, the nextest config, and the description. */
export const proposeChange = (input: {
  readonly runners: ReadonlyArray<RunnerFinding>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}): Proposal => {
  const wanted = new Set(input.runners.filter((r) => r.job !== null).map((r) => r.runner));
  const config = input.files.find((f) => f.path === NEXTEST_CONFIG)?.text ?? null;
  const skipped = new Map<Runner, string>();
  const results = [...input.files]
    .filter((f) => isWorkflow(f.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => proposeWorkflow(f.path, f.text, wanted, config, skipped));
  const uploads = results.flatMap((r) => r.uploads);
  const nextest = nextestChange(config, new Set(results.flatMap((r) => [...r.profiles])));
  const files = [
    ...results.flatMap((r) => (r.change ? [r.change] : [])),
    ...(nextest ? [nextest] : []),
  ];
  const covered = new Set(uploads.map((u) => u.runner));
  const notes = [
    ...results.flatMap((r) => r.notes),
    ...input.runners.flatMap((r) =>
      covered.has(r.runner)
        ? []
        : r.job === null
          ? [
              `${LABEL[r.runner]} shows in the repository's config, but no workflow step runs it by name, so this change does not touch it.`,
            ]
          : [
              `${LABEL[r.runner]} in job ${r.job} is left alone: ${skipped.get(r.runner) ?? "no step runs its tests by name"}.`,
            ],
    ),
  ];
  const packages = [...new Set(results.flatMap((r) => r.packages))].sort();
  return {
    files,
    uploads,
    packages,
    notes,
    description: describe(uploads, packages, notes, nextest),
  };
};

const describe = (
  uploads: ReadonlyArray<Upload>,
  packages: ReadonlyArray<string>,
  notes: ReadonlyArray<string>,
  nextest: FileChange | null,
) => {
  const out = [
    "TAG, the test aggregator, reads test reports from workflow artifacts. This change makes each test step write a report TAG reads and uploads it right after the step, even when tests fail.",
    "",
    ...uploads.map(
      (u) =>
        `- ${u.workflow}, job ${u.job}: ${LABEL[u.runner]} writes ${u.report} through ${u.how}; uploaded as ${u.artifact}.`,
    ),
  ];
  if (nextest)
    out.push(
      "",
      `${NEXTEST_CONFIG} gains a junit section, so nextest writes the file the upload reads.`,
    );
  if (packages.length > 0)
    out.push(
      "",
      `The reporters need ${packages.join(" and ")}. Add them to the dev dependencies to keep the install step plain.`,
    );
  if (notes.length > 0) out.push("", ...notes.map((n) => `- ${n}`));
  out.push(
    "",
    "Nothing else in the workflows changes. Once this merges, the next run's reports show in TAG.",
  );
  return out.join("\n");
};
