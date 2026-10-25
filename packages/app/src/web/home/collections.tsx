// The collections page and table: where a query gets a name, and the saved list.
import { useState, type ReactNode } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Bad,
  Cmd,
  Empty,
  Ink,
  K,
  Link,
  Name,
  Page,
  PillInput,
  Section,
  Space,
  Stack,
  Table,
  Topbar,
  type Column,
} from "@quality-sh/tag-ui";
import { chipOf, parseQuery } from "../../grouping.ts";
import type { CollectionRow } from "../client.ts";
import { Loaded, SignOut } from "../common.tsx";
import { collectionsAtom, createCollectionFn, deleteCollectionFn, href } from "../state.ts";
import { Dim } from "./bits.tsx";

export function CollectionsPage() {
  const result = useAtomValue(collectionsAtom);
  const [create, runCreate] = useAtom(createCollectionFn);
  const remove = useAtomSet(deleteCollectionFn);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const saving = AsyncResult.isWaiting(create);
  const submit = () => {
    if (!name.trim()) return;
    runCreate({ name: name.trim(), description: description.trim(), query: query.trim() });
    setName("");
    setDescription("");
    setQuery("");
  };
  return (
    <>
      <Topbar
        wordmark="TAG"
        href={href.overview()}
        crumbs={[{ label: "Overview", href: href.overview() }, { label: "Collections" }]}
        actions={<SignOut />}
      />
      <Page>
        <Space top={28}>
          <Loaded result={result}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No collections yet. Make one below.</Empty>
              ) : (
                <CollectionsTable rows={list} onDelete={(id) => remove(id)} />
              )
            }
          </Loaded>
        </Space>
        <Section eyebrow="New collection">
          <div style={{ maxWidth: "34rem" }}>
            <Stack gap={14}>
              <Field label="Name">
                <PillInput label="Name" value={name} onChange={setName} placeholder="payments" />
              </Field>
              <Field label="Description">
                <PillInput
                  label="Description"
                  value={description}
                  onChange={setDescription}
                  placeholder="what this watches"
                />
              </Field>
              <Field label="Include runs where">
                <PillInput
                  label="Include runs where"
                  value={query}
                  onChange={setQuery}
                  placeholder="org:acme tag:smoke -env:staging"
                />
              </Field>
              <div>
                <Cmd primary onClick={submit} disabled={saving || !name.trim()}>
                  {saving ? "saving…" : "create collection"}
                </Cmd>
              </div>
            </Stack>
          </div>
        </Section>
      </Page>
    </>
  );
}

/** Collections as rows: what each holds now, and where it opens. */
export function CollectionsTable({
  rows,
  onDelete,
}: {
  rows: ReadonlyArray<CollectionRow>;
  onDelete?: (id: string) => void;
}) {
  const columns: Column<CollectionRow>[] = [
    {
      key: "name",
      head: "Collection",
      wrap: true,
      cell: (c) => (
        <Name sub={c.description || undefined}>
          <Link ink href={href.scope({ kind: "collection", id: c.id })}>
            {c.name}
          </Link>
        </Name>
      ),
    },
    {
      key: "q",
      head: "Include runs where",
      cell: (c) =>
        c.query ? (
          <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
            {parseQuery(c.query).map((f, i) => {
              const chip = chipOf(f);
              return (
                <K key={i}>
                  {chip.field}: <Ink>{chip.value}</Ink>
                </K>
              );
            })}
          </span>
        ) : (
          <Dim>every run</Dim>
        ),
    },
    { key: "repos", head: "Repositories", right: true, cell: (c) => c.repos },
    { key: "runs", head: "Runs · 30d", right: true, cell: (c) => c.runs },
    {
      key: "failing",
      head: "Failing",
      right: true,
      cell: (c) => (c.failing ? <Bad>{c.failing}</Bad> : <Dim>0</Dim>),
    },
  ];
  if (onDelete)
    columns.push({
      key: "x",
      head: "",
      right: true,
      cell: (c) => (
        <Cmd small onClick={() => onDelete(c.id)}>
          delete
        </Cmd>
      ),
    });
  return <Table middle columns={columns} rows={rows} rowKey={(c) => c.id} />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <K>{label}</K>
      {children}
    </label>
  );
}
