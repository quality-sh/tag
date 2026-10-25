// The report row as the index holds it: the fields every grouping and view reads.

/** A report as the index holds it, plus the fields groupings need. */
export interface ReportLite {
  readonly reportId: string;
  readonly runId: string;
  readonly owner: string;
  readonly repo: string;
  readonly tool: string;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly workflow: string | null;
  readonly environment: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly timestamp: string;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly duration: number;
  readonly buildUrl: string | null;
}
