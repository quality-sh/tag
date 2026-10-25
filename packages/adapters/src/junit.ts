// JUnit XML -> CTRF. Handles <testsuites> and bare <testsuite>, pytest/surefire/gradle/jest-junit flavours.
import { XMLParser } from "fast-xml-parser";
import {
  CTRF_SPEC_VERSION,
  type CtrfReport,
  type CtrfTest,
  type Mutable,
} from "@quality-sh/tag-schema";
import { basename, environmentFrom, isXml, type Adapter, type AdapterInput } from "./types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  isArray: (name) =>
    ["testsuite", "testcase", "failure", "error", "skipped", "property"].includes(name),
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const textOf = (n: unknown): string => {
  if (typeof n === "string") return n;
  if (n && typeof n === "object") return str((n as Node)["#text"]) ?? "";
  return "";
};

function looksLikeJUnit(xml: string): boolean {
  return /<testsuites?[\s>]/.test(xml.slice(0, 2000));
}

export function convertJUnit(
  xml: string,
  ctx: AdapterInput["context"],
  sourcePath: string,
): CtrfReport {
  const doc = parser.parse(xml) as Node;
  const root = (doc.testsuites as Node | undefined) ?? doc;
  const suites: Node[] = (root.testsuite as Node[] | undefined) ?? [];
  const tests: CtrfTest[] = [];
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;

  for (const suite of suites) {
    const suiteName = str(suite.name) ?? "suite";
    const suiteStart = typeof suite.timestamp === "string" ? Date.parse(suite.timestamp) : NaN;
    let cursor = Number.isFinite(suiteStart)
      ? suiteStart
      : ctx.timestamp
        ? Date.parse(ctx.timestamp)
        : Date.now();
    for (const tc of (suite.testcase as Node[] | undefined) ?? []) {
      const durationMs = Math.round(num(tc.time) * 1000);
      const className = str(tc.classname);
      const failures = [...((tc.failure as Node[]) ?? []), ...((tc.error as Node[]) ?? [])];
      const skipped = (tc.skipped as Node[] | undefined) ?? [];
      const status: CtrfTest["status"] = failures.length
        ? "failed"
        : skipped.length
          ? "skipped"
          : "passed";
      const suitePath: [string, ...string[]] = [
        suiteName,
        ...(className ? className.split(".").filter(Boolean) : []),
      ];
      const t: Mutable<CtrfTest> = {
        name: str(tc.name) ?? "unnamed",
        status,
        duration: durationMs,
        start: cursor,
        stop: cursor + durationMs,
        suite: suitePath,
        rawStatus: (tc.error as Node[] | undefined)?.length ? "error" : status,
      };
      const file = str(tc.file);
      if (file) t.filePath = file;
      if (tc.line !== undefined) t.line = num(tc.line);
      if (failures.length) {
        const f = failures[0]!;
        const msg = str(f.message);
        const body = textOf(f);
        const firstLine = body.split("\n")[0];
        if (msg) t.message = msg;
        else if (firstLine) t.message = firstLine;
        if (body) t.trace = body;
      } else if (skipped.length) {
        const msg = str(skipped[0]!.message);
        if (msg) t.message = msg;
      }
      const out = textOf(tc["system-out"]);
      const err = textOf(tc["system-err"]);
      if (out) t.stdout = out.split("\n");
      if (err) t.stderr = err.split("\n");
      tests.push(t);
      earliest = Math.min(earliest, cursor);
      cursor += durationMs;
      latest = Math.max(latest, cursor);
    }
  }
  if (!Number.isFinite(earliest))
    earliest = latest = ctx.timestamp ? Date.parse(ctx.timestamp) : Date.now();

  const count = (s: CtrfTest["status"]) => tests.filter((t) => t.status === s).length;
  const toolName =
    suites.length === 1 && str(suites[0]!.name) ? (str(suites[0]!.name) as string) : "junit";
  return {
    reportFormat: "CTRF",
    specVersion: CTRF_SPEC_VERSION,
    runId: ctx.runId,
    // The run's time when CI gave one: a suite's own stamp can be stale or missing.
    timestamp: ctx.timestamp ?? new Date(earliest).toISOString(),
    generatedBy: "tag-adapter-junit",
    results: {
      tool: {
        name: toolName.toLowerCase() === "pytest" ? "pytest" : "junit",
        extra: { "junit.suiteName": toolName },
      },
      summary: {
        tests: tests.length,
        passed: count("passed"),
        failed: count("failed"),
        skipped: count("skipped"),
        pending: 0,
        other: 0,
        start: earliest,
        stop: latest,
        duration: latest - earliest,
        suites: suites.length,
      },
      tests,
      environment: environmentFrom(ctx),
      extra: {
        "tag.artifacts": [
          {
            kind: "junit-xml",
            name: basename(sourcePath),
            path: sourcePath,
            contentType: "application/xml",
          },
        ],
      },
    },
  };
}

export const junitAdapter: Adapter = {
  name: "junit",
  version: "0.1.0",
  detect: (paths) => paths.some(isXml),
  async parse({ files, context }) {
    const out: CtrfReport[] = [];
    for (const f of files.filter((f) => isXml(f.path))) {
      const xml = await f.text();
      if (!looksLikeJUnit(xml)) continue;
      out.push(convertJUnit(xml, context, f.path));
    }
    return out;
  },
};
