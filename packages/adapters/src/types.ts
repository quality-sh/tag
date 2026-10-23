import type { CtrfReport } from "@quality-sh/verdict-schema";

/** A file inside an extracted artifact. Paths are relative, posix separators. */
export interface FileRef {
  path: string;
  size: number;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

/** What the ingester knows about the run the artifact came from. */
export interface RunContext {
  owner: string;
  repo: string;
  runId: string;
  artifactName: string;
  branch?: string;
  commit?: string;
  buildUrl?: string;
  /** ISO 8601 */
  timestamp?: string;
  /** The CI workflow; CTRF carries it as `buildName`. */
  workflow?: string;
  /** Where the tests ran; CTRF carries it as `testEnvironment`. */
  environment?: string;
}

export interface AdapterInput {
  files: FileRef[];
  context: RunContext;
}

/**
 * An adapter turns framework output into CTRF. Pure: no I/O beyond reading the
 * files it is given, no framework dependencies, no Effect.
 */
export interface Adapter {
  name: string;
  version: string;
  /** Cheap check on file names only. */
  detect(paths: string[]): boolean;
  /** May return several reports (one artifact can hold several result files). */
  parse(input: AdapterInput): Promise<CtrfReport[]>;
}

export function environmentFrom(ctx: RunContext) {
  const env: Record<string, string> = {
    repositoryName: `${ctx.owner}/${ctx.repo}`,
    repositoryUrl: `https://github.com/${ctx.owner}/${ctx.repo}`,
    buildId: ctx.runId,
  };
  if (ctx.branch) env.branchName = ctx.branch;
  if (ctx.commit) env.commit = ctx.commit;
  if (ctx.buildUrl) env.buildUrl = ctx.buildUrl;
  if (ctx.workflow) env.buildName = ctx.workflow;
  if (ctx.environment) env.testEnvironment = ctx.environment;
  return env;
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}
