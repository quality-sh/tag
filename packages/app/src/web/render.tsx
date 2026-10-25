// The JSON Render spike: a page as a flat JSON spec over a small catalog of TAG components.
// A spec is data, so a server, a file or a model can produce one; the renderer binds it to
// the page's data with `{ "$": "path" }` values and repeats children with `each`.
import type { ReactNode } from "react";
import { lookup, resolve, type Component, type Scope, type Spec } from "./spec.ts";
import {
  Disclosure,
  Facts,
  Fields,
  Figures,
  K,
  Link,
  Mark,
  Message,
  Meter,
  Row,
  Rows,
  Section,
  Stack,
  Q,
  fmtMs,
  toneOf,
  type Tone,
} from "@quality-sh/tag-ui";

// ---------------------------------------------------------------------------
// The catalog: each component takes resolved props and rendered children.

const str = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
const num = (v: unknown) => (typeof v === "number" ? v : null);
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

type Props = Record<string, unknown>;
type Renderer = (props: Props, children: ReactNode) => ReactNode;

const components: Record<Component, Renderer> = {
  section: (p, children) => (
    <Section eyebrow={str(p.eyebrow)} count={p.count === undefined ? undefined : str(p.count)}>
      {children}
    </Section>
  ),
  figures: (p) => (
    <Figures
      items={list<{
        key: string;
        label: string;
        value: string;
        unit?: string;
        note?: string;
        tone?: Tone;
      }>(p.items)}
    />
  ),
  facts: (p) => {
    const items = list<string>(p.items);
    return items.length ? <Facts>{items}</Facts> : null;
  },
  rows: (_, children) => <Rows>{children}</Rows>,
  row: (p, children) => (
    <Row
      title={
        p.href ? (
          <Link ink href={str(p.href)}>
            {str(p.title)}
          </Link>
        ) : (
          str(p.title)
        )
      }
      facts={
        <>
          {p.status !== undefined && <Mark tone={toneOf(str(p.status))} />}
          {num(p.duration) !== null && <K>{fmtMs(num(p.duration) ?? 0)}</K>}
        </>
      }
    >
      {children}
    </Row>
  ),
  stack: (p, children) => <Stack gap={num(p.gap) ?? 10}>{children}</Stack>,
  meter: (p) => (
    <div>
      <Meter
        name={str(p.name)}
        value={num(p.value)}
        threshold={num(p.threshold)}
        comparator={typeof p.comparator === "string" ? p.comparator : null}
        passed={typeof p.passed === "boolean" ? p.passed : null}
      />
      {typeof p.reason === "string" && p.reason && (
        <div style={{ marginTop: 6 }}>
          <Q>{p.reason}</Q>
        </div>
      )}
      {typeof p.error === "string" && p.error && <Message>{p.error}</Message>}
    </div>
  ),
  message: (p) => <Message>{str(p.text)}</Message>,
  fields: (p) => {
    const items = list<{ label: string; value: string }>(p.items);
    return items.length ? (
      <div style={{ marginTop: 14 }}>
        <Disclosure summary={str(p.summary) || "details"}>
          <Fields items={items} />
        </Disclosure>
      </div>
    ) : null;
  },
};

// ---------------------------------------------------------------------------
// The renderer

export function Render({ spec, data }: { spec: Spec; data: Scope }) {
  const draw = (id: string, scope: Scope): ReactNode => {
    const el = spec.elements[id];
    if (!el) return <Message key={id}>spec: no element “{id}”</Message>;
    const props = resolve(el.props ?? {}, scope) as Props;
    const kids = (s: Scope) => (el.children ?? []).map((c) => draw(c, s));
    const children = el.each
      ? list<unknown>(lookup(scope, el.each.path)).map((item) => {
          const s = { ...scope, [el.each!.as]: item };
          const key = str(lookup(s, el.each!.key));
          return <RenderList key={key}>{kids(s)}</RenderList>;
        })
      : kids(scope);
    return <RenderList key={id}>{components[el.type](props, children)}</RenderList>;
  };
  return <>{draw(spec.root, data)}</>;
}

/** A keyed wrapper that adds no markup. */
function RenderList({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
