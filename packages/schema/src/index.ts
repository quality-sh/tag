export * from "./ctrf.ts";
export * from "./conventions.ts";
export * from "./identity.ts";

import { Schema } from "effect";
import { CtrfReport } from "./ctrf.ts";

export type ValidationResult = { ok: true; report: CtrfReport } | { ok: false; errors: string[] };

const decode = Schema.decodeUnknownResult(CtrfReport, { onExcessProperty: "error", errors: "all" });

/** Strict CTRF validation: unknown keys outside `extra` are errors. Pure, no Effect in the signature. */
export function validateReport(input: unknown): ValidationResult {
  const r = decode(input);
  if (r._tag === "Success") return { ok: true, report: r.success };
  const message = r.failure.message;
  return { ok: false, errors: message.split("\n").filter((l) => l.trim().length > 0) };
}

/** JSON Schema (draft 2020-12) for the public contract. Used by docs/schema.md and the API. */
export function reportJsonSchema() {
  return Schema.toJsonSchemaDocument(CtrfReport, { onExcessProperty: "error" });
}

/** Shallow mutable view, for adapters that build a record field by field before returning it. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
