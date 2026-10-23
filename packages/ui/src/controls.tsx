import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, sizes, text, tokens } from "./theme.stylex";

export interface SegOption<V extends string> {
  readonly value: V;
  readonly label: ReactNode;
}

const seg = stylex.create({
  group: {
    position: "relative",
    display: "inline-flex",
    gap: 2,
    minWidth: 0,
    maxWidth: "100%",
    padding: 2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.line,
    borderRadius: 5,
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  option: {
    flexShrink: 0,
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: text.micro,
    lineHeight: 1,
    letterSpacing: "0.06em",
    color: { default: tokens.mauve, ":hover": tokens.ink },
    backgroundColor: "transparent",
    borderRadius: sizes.radius,
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 10,
    paddingRight: 10,
    cursor: "pointer",
  },
  pressed: {
    backgroundColor: tokens.surface2,
    color: tokens.ink,
    boxShadow: `inset 0 -1px 0 ${tokens.rosegold}`,
  },
});

/** The segmented control: one pressed option, mono labels, rosegold underline. */
export function Seg<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<SegOption<V>>;
  value: V;
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} {...stylex.props(seg.group)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          {...stylex.props(seg.option, o.value === value && seg.pressed)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const cmd = stylex.create({
  base: {
    fontFamily: fonts.mono,
    fontSize: 13,
    letterSpacing: "0.02em",
    color: tokens.ink,
    backgroundColor: { default: "rgba(12, 10, 14, 0.6)", ":hover": "rgba(12, 10, 14, 0.75)" },
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: tokens.lineSoft,
      ":hover": "rgba(235, 188, 186, 0.35)",
      ":focus-visible": "rgba(235, 188, 186, 0.5)",
    },
    borderRadius: 999,
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: 22,
    paddingRight: 22,
    display: "inline-flex",
    alignItems: "center",
    gap: 14,
    maxWidth: "100%",
    cursor: "pointer",
    outline: "none",
    transitionProperty: "border-color, background-color, color",
    transitionDuration: "0.45s, 0.45s, 0.15s",
    whiteSpace: "nowrap",
  },
  primary: {
    backgroundColor: { default: tokens.rosegold, ":hover": tokens.primaryHover },
    color: tokens.onPrimary,
    borderColor: "transparent",
  },
  small: { paddingTop: 6, paddingBottom: 6, paddingLeft: 14, paddingRight: 14, fontSize: 11 },
  disabled: { opacity: 0.5, cursor: "default" },
});

export function Cmd({
  children,
  onClick,
  disabled,
  primary,
  small,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  small?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      {...stylex.props(
        cmd.base,
        primary && cmd.primary,
        small && cmd.small,
        disabled && cmd.disabled,
      )}
    >
      {children}
    </button>
  );
}

const field = stylex.create({
  base: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: tokens.ink,
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: tokens.line, ":focus-visible": tokens.rosegold },
    borderRadius: sizes.radius,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 10,
    paddingRight: 10,
    outline: "none",
  },
  select: {
    appearance: "none",
    paddingRight: 26,
    backgroundImage: `linear-gradient(45deg, transparent 50%, ${tokens.mauve} 50%), linear-gradient(135deg, ${tokens.mauve} 50%, transparent 50%)`,
    backgroundPosition: "calc(100% - 14px) 50%, calc(100% - 9px) 50%",
    backgroundSize: "5px 5px",
    backgroundRepeat: "no-repeat",
  },
  pill: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: tokens.ink,
    backgroundColor: "rgba(12, 10, 14, 0.6)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: tokens.lineSoft, ":focus-visible": "rgba(235, 188, 186, 0.5)" },
    borderRadius: 999,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 24,
    paddingRight: 24,
    minWidth: "18rem",
    outline: "none",
  },
});

export function Select({
  value,
  onChange,
  options,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
  label: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      {...stylex.props(field.base, field.select)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The pill input that pairs with a primary Cmd, as the sign-in form. */
export function PillInput({
  value,
  onChange,
  placeholder,
  label,
  type = "text",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  type?: "text" | "password";
  autoFocus?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      autoFocus={autoFocus}
      {...stylex.props(field.pill)}
    />
  );
}

const toolbar = stylex.create({
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
    paddingBottom: "1.5rem",
  },
});

export function Toolbar({ children }: { children: ReactNode }) {
  return <div {...stylex.props(toolbar.row)}>{children}</div>;
}
