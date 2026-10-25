// The search bar: the query as text at the left and chips at the right, fed by the
// server's suggestions for the word being typed.
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import { SearchBar, type Chip, type Suggestion as UiSuggestion } from "@quality-sh/tag-ui";
import { chipOf, formatQuery, parseQuery, type Suggestion } from "../../grouping.ts";
import { suggestionsAtom, typedAtom } from "../state.ts";

export function Search({
  q,
  label,
  onQuery,
}: {
  q: string;
  label: string;
  onQuery: (q: string) => void;
}) {
  const [typed, setTyped] = useAtom(typedAtom);
  const result = useAtomValue(suggestionsAtom(typed));
  const suggestions = AsyncResult.isSuccess(result) ? result.value : [];
  const filters = parseQuery(q);
  const chips: Chip[] = filters.map((f, i) => ({ key: `${i}`, ...chipOf(f) }));
  const navigate = (next: string) => onQuery(next.trim());
  const uiSuggestions: UiSuggestion[] = suggestions.map((s) => ({
    key: s.token,
    field: s.kind === "text" ? null : s.kind === "field" ? "field" : (s.field ?? ""),
    value: s.value,
    count: s.count,
    note: s.note,
    partial: s.kind === "field",
  }));
  const pick = (u: UiSuggestion) => {
    const s = suggestions.find((x: Suggestion) => x.token === u.key);
    if (!s) return;
    if (s.kind === "field") {
      setTyped(s.token);
      return;
    }
    setTyped("");
    navigate(`${q} ${s.token}`);
  };
  return (
    <SearchBar
      label={label}
      typed={typed}
      onTyped={setTyped}
      chips={chips}
      onRemove={(c) => navigate(formatQuery(filters.filter((_, i) => `${i}` !== c.key)))}
      suggestions={uiSuggestions}
      onPick={pick}
      onSubmit={(text) => {
        setTyped("");
        navigate(`${q} ${text}`);
      }}
    />
  );
}
