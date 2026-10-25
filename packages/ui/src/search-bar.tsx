// The search bar: typed words at the left, applied filters as chips at the
// right, and a flat menu of suggestions under the bar.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, sizes, text, tokens } from "./theme.stylex";

// ---------------------------------------------------------------------------
// Search bar

export interface Chip {
  readonly key: string;
  readonly field: string;
  readonly value: string;
}

export interface Suggestion {
  readonly key: string;
  /** Null for the free-text search row. */
  readonly field: string | null;
  readonly value: string;
  readonly count: number | null;
  readonly note: string;
  /** True when choosing it only narrows the next suggestions (a field name). */
  readonly partial: boolean;
}

const search = stylex.create({
  wrap: { position: "relative", zIndex: 5 },
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 2,
    paddingRight: 2,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: { default: tokens.line, ":focus-within": tokens.rosegold },
    transitionProperty: "border-color",
    transitionDuration: "0.2s",
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "12rem",
    minWidth: 0,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    color: tokens.ink,
    backgroundColor: "transparent",
    borderWidth: 0,
    outline: "none",
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 2,
    paddingRight: 2,
    "::placeholder": { color: tokens.muted },
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "flex-end",
    marginLeft: "auto",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    backgroundColor: tokens.surface2,
    borderRadius: sizes.radius,
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 8,
    paddingRight: 6,
    whiteSpace: "nowrap",
  },
  chipField: { color: tokens.mauve, "::after": { content: '":"' } },
  chipValue: { color: tokens.ink },
  chipX: {
    color: { default: tokens.muted, ":hover": tokens.rose },
    backgroundColor: "transparent",
    borderWidth: 0,
    cursor: "pointer",
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    padding: 2,
  },
  menu: {
    position: "absolute",
    left: 0,
    top: "calc(100% + 4px)",
    width: "min(340px, 100%)",
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.hair,
    borderRadius: sizes.cardRadius,
    boxShadow: sizes.shadowOverlay,
    paddingTop: 4,
    paddingBottom: 4,
    listStyle: "none",
    margin: 0,
  },
  item: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    alignItems: "center",
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 12,
    paddingRight: 12,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1.4,
    color: tokens.ink,
    cursor: "pointer",
    backgroundColor: { default: "transparent", ":hover": tokens.surface2 },
  },
  itemOn: { backgroundColor: tokens.surface2 },
  itemField: { color: tokens.mauve, "::after": { content: '":"', marginRight: 2 } },
  itemNote: { color: tokens.muted, fontSize: text.micro, whiteSpace: "nowrap" },
  textRow: {
    color: tokens.mauve,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.lineSoft,
    marginTop: 4,
    paddingTop: 9,
  },
});

/**
 * Typed text at the left, applied filters as chips at the right, a flat menu
 * of suggestions under the bar. The parent owns both the typed text and the
 * chips; the bar only reports picks and removals.
 */
export function SearchBar({
  typed,
  onTyped,
  chips,
  onRemove,
  suggestions,
  onPick,
  onSubmit,
  label,
  placeholder = "filter: repo, branch, tag, env, failed:>0, or any text",
}: {
  typed: string;
  onTyped: (text: string) => void;
  chips: ReadonlyArray<Chip>;
  onRemove: (chip: Chip) => void;
  suggestions: ReadonlyArray<Suggestion>;
  onPick: (s: Suggestion) => void;
  /** Enter with no suggestion chosen: the typed text as written. */
  onSubmit: (text: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setActive(0), [suggestions]);
  const show = open && typed.trim().length > 0 && suggestions.length > 0;

  const pick = (s: Suggestion) => {
    onPick(s);
    setOpen(true);
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && show) {
      e.preventDefault();
      setActive((a) => Math.min(suggestions.length - 1, a + 1));
    } else if (e.key === "ArrowUp" && show) {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = show ? suggestions[active] : undefined;
      if (s) pick(s);
      else if (typed.trim()) onSubmit(typed.trim());
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && typed === "" && chips.length > 0) {
      onRemove(chips[chips.length - 1]!);
    }
  };

  return (
    <div {...stylex.props(search.wrap)}>
      <div role="search" aria-label={label} {...stylex.props(search.bar)}>
        <input
          ref={input}
          value={typed}
          onChange={(e) => {
            onTyped(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
          placeholder={chips.length ? "" : placeholder}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={show}
          autoComplete="off"
          spellCheck={false}
          {...stylex.props(search.input)}
        />
        {chips.length > 0 && (
          <span {...stylex.props(search.chips)}>
            {chips.map((c) => (
              <span key={c.key} {...stylex.props(search.chip)}>
                <span {...stylex.props(search.chipField)}>{c.field}</span>
                <span {...stylex.props(search.chipValue)}>{c.value}</span>
                <button
                  type="button"
                  aria-label={`remove ${c.field} ${c.value}`}
                  onClick={() => onRemove(c)}
                  {...stylex.props(search.chipX)}
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        )}
      </div>
      {show && (
        <ul role="listbox" aria-label="Suggestions" {...stylex.props(search.menu)}>
          {suggestions.map((s, i) => (
            <li
              key={s.key}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              {...stylex.props(
                search.item,
                i === active && search.itemOn,
                s.field === null && search.textRow,
              )}
            >
              <span>
                {s.field !== null && <span {...stylex.props(search.itemField)}>{s.field}</span>}
                {s.field === null ? `search for “${s.value}”` : s.value}
              </span>
              <span {...stylex.props(search.itemNote)}>{s.count !== null ? s.count : s.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
