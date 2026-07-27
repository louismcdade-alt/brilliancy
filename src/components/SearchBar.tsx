interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  loading?: boolean;
  variant?: "hero" | "bar";
  autoFocus?: boolean;
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  loading = false,
  variant = "hero",
  autoFocus = false,
}: SearchBarProps) {
  return (
    <form
      className="hero-search-row"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="search">
        <span className="search-at">@</span>
        <input
          className="search-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={variant === "hero" ? "your chess.com username" : "username"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label="chess.com username"
        />
      </label>
      <button type="submit" className="btn btn-bril" disabled={loading || !value.trim()}>
        {loading ? <span className="spinner" /> : variant === "hero" ? "Reveal" : "Go"}
      </button>
    </form>
  );
}
