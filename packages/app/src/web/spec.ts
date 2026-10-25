// The JSON Render spec: a flat tree of catalog elements, validated with Effect Schema, and
// the binding rules that tie its props to page data. No React here, so it is testable alone.
import { Schema } from "effect";

export const CATALOG = [
  "section",
  "figures",
  "facts",
  "rows",
  "row",
  "stack",
  "meter",
  "message",
  "fields",
] as const;
export type Component = (typeof CATALOG)[number];

export const Element = Schema.Struct({
  type: Schema.Literals(CATALOG),
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  children: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Render the children once per item at `path`, bound to `as`; `key` names the item's id. */
  each: Schema.optionalKey(
    Schema.Struct({ path: Schema.String, as: Schema.String, key: Schema.String }),
  ),
});
export const Spec = Schema.Struct({
  root: Schema.String,
  elements: Schema.Record(Schema.String, Element),
});
export interface Spec extends Schema.Schema.Type<typeof Spec> {}
export const decodeSpec = Schema.decodeUnknownResult(Spec);

export type Scope = Record<string, unknown>;

/** `{ "$": "a.b.c" }` reads a path from the scope (loop variables first, then the page data). */
export const isBinding = (v: unknown): v is { $: string } =>
  typeof v === "object" && v !== null && "$" in v && typeof v.$ === "string";

export const lookup = (scope: Scope, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[k];
  }, scope);

export const resolve = (v: unknown, scope: Scope): unknown => {
  if (isBinding(v)) return lookup(scope, v.$);
  if (Array.isArray(v)) return v.map((x) => resolve(x, scope));
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, scope)]));
  return v;
};
