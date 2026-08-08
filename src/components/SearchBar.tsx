import { useRef } from "react";
import type { Source } from "../types";

/**
 * The source picker is a SEGMENTED CONTROL, not auto-detection.
 *
 * Auto-detecting from the username is the tempting option and it is the wrong
 * one: names are not unique across the two sites (plenty of players hold the
 * same handle on both, and plenty more hold a handle on one that belongs to a
 * stranger on the other), so a detector has to fire two lookups on every search
 * and then either guess — silently showing someone a stranger's games — or put a
 * "we found two, which did you mean?" prompt in front of a user who already
 * knew the answer before they typed. That is more latency and more UI to resolve
 * an ambiguity the user never had.
 *
 * A picker also happens to be exactly what the page already is. The scoresheet's
 * whole idiom is pre-printed fields with boxes you tick, and "How far back" in
 * the scan panel is already this control — so the classes here are `scope-seg` /
 * `scope-opt`, reused rather than reinvented, and a Lichess search is filled in
 * the same way a scan window is.
 */
const SOURCES: { id: Source; label: string }[] = [
  { id: "chesscom", label: "chess.com" },
  { id: "lichess", label: "lichess" },
];

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  source: Source;
  onSourceChange: (s: Source) => void;
  onSubmit: () => void;
  loading?: boolean;
  variant?: "hero" | "bar";
  autoFocus?: boolean;
}

export function SearchBar({
  value,
  onChange,
  source,
  onSourceChange,
  onSubmit,
  loading = false,
  variant = "hero",
  autoFocus = false,
}: SearchBarProps) {
  const site = source === "lichess" ? "Lichess" : "chess.com";
  const input = useRef<HTMLInputElement>(null);
  return (
    // The picker sits OUTSIDE the <form>, not inside it. That is not cosmetic:
    // scripts/csp-check.mjs drives a real session through
    // `form.hero-search-row button[type="submit"]`, and turning the form into a
    // two-row container would have silently broken the production-CSP test that
    // exists to stop this app shipping a policy that blocks its own engine.
    <div className="search-form">
      {/* Printed field label, then the boxes — the hero has room to say what the
          control is; the topbar doesn't, so there the segments speak for
          themselves. */}
      <div className="source-row">
        {variant === "hero" && <span className="scope-label">Source</span>}
        <div className="scope-seg scope-seg-sm" role="group" aria-label="Chess site">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`scope-opt ${source === s.id ? "is-on" : ""}`}
              aria-pressed={source === s.id}
              onClick={() => onSourceChange(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <form
        className="hero-search-row"
        onSubmit={(e) => {
          e.preventDefault();
          // Empty is not an error worth a message — it's a field nobody has
          // filled in yet — so the submit puts the caret where the answer goes
          // instead of refusing. loadUser() also returns early on an empty
          // name, so nothing downstream depends on the button being disabled.
          if (!value.trim()) {
            input.current?.focus();
            return;
          }
          onSubmit();
        }}
      >
        <label className="search">
          <span className="search-at">@</span>
          <input
            ref={input}
            className="search-input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={variant === "hero" ? `your ${site} username` : "username"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={autoFocus}
            aria-label={`${site} username`}
          />
        </label>
        {/* The spinner is an empty span, so swapping the label for it left the
            site's primary control with no accessible name for the whole load.
            aria-label keeps one throughout. */}
        {/* Disabled ONLY while a request is in flight. It used to be disabled
            whenever the field was empty, which is its state on every first
            paint — so the landing page's primary call to action, the one object
            the hero is built around, was rendered at 50% opacity as a grey slab
            for every visitor before they touched anything, and offered no
            explanation of what would un-grey it. */}
        <button
          type="submit"
          className="btn btn-bril"
          disabled={loading}
          aria-label={loading ? `Loading ${site} profile` : undefined}
        >
          {loading ? <span className="spinner" /> : variant === "hero" ? "Reveal" : "Go"}
        </button>
      </form>
    </div>
  );
}
