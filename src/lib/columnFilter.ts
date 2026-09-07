/**
 * The little box above each column: "> 10m", "< 6.2", "yes".
 *
 * A table of forty mutations sorted on one number still answers one question at a time, and the
 * question a player actually has is a conjunction — *cheap enough to plant, profitable enough to
 * bother, and no watering*. Sorting cannot express that. These filters can, one column at a time,
 * and they compose because every column keeps its own.
 *
 * Three decisions worth stating, because each has a wrong-looking alternative:
 *
 * **A number carries its own scale.** `10m` and `10,000,000` and `10000000` are the same figure,
 * because the table prints the first and a player types whichever they are thinking in. Suffixes
 * are the ones the game uses — k, m, b — and case never matters.
 *
 * **Bad input filters nothing.** A half-typed `>` or a stray letter leaves every row in place and
 * marks the box instead. The alternative — treating "unparseable" as "matches nothing" — empties
 * the table mid-keystroke on the way to a valid filter, which reads as "no mutation qualifies"
 * rather than "you are not finished typing".
 *
 * **A bare number means at least that much.** It is the one form with no operator to read, and
 * the columns are mostly things you want more of. Type `<` when you want less.
 */

/** What a column's box will accept. `hours` is a number in hours; the unit is the column's. */
export type FilterKind = "number" | "hours" | "boolean" | "text";

/**
 * Passes a row, given the column's sort value and the plain text of its cell.
 *
 * Both, because the two kinds of column read different halves: a numeric filter compares the value
 * the table already sorts on — which is where the sentinels for "unpriced" and "never rots" live,
 * so those keep behaving as they sort — while `yes`/`no` and a name are only ever text.
 */
export type Matcher = (value: number, label: string) => boolean;

export type ParsedFilter =
  /** Nothing typed. Every row passes; the column is not filtering. */
  | { state: "blank" }
  /** Typed but not readable. Every row passes, and the caller marks the box. */
  | { state: "bad"; typed: string }
  | { state: "ok"; typed: string; label: string; test: Matcher };

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * "10m" -> 10000000, "1.5k" -> 1500, "2,000" -> 2000, "6.2" -> 6.2, "-5m" -> -5000000.
 *
 * Returns null rather than NaN for anything it cannot read, so a caller cannot mistake a failure
 * for a number: `NaN` compares false against everything and would silently empty a column.
 */
export function parseAmount(text: string): number | null {
  const cleaned = text.trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "").replace(/%$/, "");
  const match = /^(-?\d*\.?\d+)([kmb])?$/.exec(cleaned);
  if (!match) return null;
  const size = Number(match[1]);
  if (!Number.isFinite(size)) return null;
  return size * (match[2] ? SUFFIX[match[2]] : 1);
}

/** The figure as a person would type it back: 10m, 1.5k, 6.2. */
function showAmount(value: number): string {
  const size = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  for (const [suffix, scale] of [["b", 1e9], ["m", 1e6], ["k", 1e3]] as const) {
    if (size >= scale) return `${sign}${trim(size / scale)}${suffix}`;
  }
  return `${sign}${trim(size)}`;
}

const trim = (n: number) => String(Number(n.toFixed(2)));

const YES = new Set(["yes", "y", "true", "t", "1"]);
const NO = new Set(["no", "n", "false", "f", "0"]);
/** The cell for a mutation with nothing to say — kept readable so a column can still be swept. */
const UNKNOWN = new Set(["-", "--", "—", "?", "none", "unknown"]);

/**
 * Read one box.
 *
 * Numbers accept `>`, `>=`, `<`, `<=`, `=` and a bare figure, plus `a-b` for a range — which is
 * why a negative number has to be told from a range: `-5m` is a figure, `1m-5m` is a span, and the
 * difference is whether anything came before the dash.
 */
export function parseFilter(typed: string, kind: FilterKind): ParsedFilter {
  const text = typed.trim();
  if (text === "") return { state: "blank" };

  if (kind === "text") {
    const needle = text.toLowerCase();
    // Labelled without the word "name": it is read back after the column's own heading, and
    // "Mutation name contains" says it twice.
    return { state: "ok", typed, label: `contains "${text}"`, test: (_v, label) => label.toLowerCase().includes(needle) };
  }

  if (kind === "boolean") {
    const word = text.toLowerCase().replace(/^[=<>]+/, "").trim();
    const want = YES.has(word) ? "yes" : NO.has(word) ? "no" : UNKNOWN.has(word) ? "unknown" : null;
    if (!want) return { state: "bad", typed };
    return {
      state: "ok",
      typed,
      label: want === "unknown" ? "not stated" : want,
      test: (_v, label) => {
        const cell = label.trim().toLowerCase();
        const read = YES.has(cell) ? "yes" : NO.has(cell) ? "no" : "unknown";
        return read === want;
      },
    };
  }

  const unit = kind === "hours" ? " hr" : "";

  // A range: `1m-5m`, `2-8`. Checked before the operators so the dash is not read as a minus.
  const range = /^([^-\s][^-]*)-(.+)$/.exec(text);
  if (range) {
    const low = parseAmount(range[1]);
    const high = parseAmount(range[2]);
    if (low !== null && high !== null) {
      const [from, to] = low <= high ? [low, high] : [high, low];
      return {
        state: "ok",
        typed,
        label: `${showAmount(from)} to ${showAmount(to)}${unit}`,
        test: (value) => value >= from && value <= to,
      };
    }
  }

  const operator = /^(>=|<=|=>|=<|>|<|=|≥|≤)?\s*(.+)$/.exec(text);
  if (!operator) return { state: "bad", typed };
  const amount = parseAmount(operator[2]);
  if (amount === null) return { state: "bad", typed };

  switch (operator[1]) {
    case ">":
      return { state: "ok", typed, label: `over ${showAmount(amount)}${unit}`, test: (v) => v > amount };
    case "<":
      return { state: "ok", typed, label: `under ${showAmount(amount)}${unit}`, test: (v) => v < amount };
    case "<=":
    case "=<":
    case "≤":
      return { state: "ok", typed, label: `${showAmount(amount)}${unit} or less`, test: (v) => v <= amount };
    case "=":
      return { state: "ok", typed, label: `exactly ${showAmount(amount)}${unit}`, test: (v) => v === amount };
    // `>=`, `=>`, `≥`, and a bare figure, which is the same question asked without the symbol.
    default:
      return { state: "ok", typed, label: `${showAmount(amount)}${unit} or more`, test: (v) => v >= amount };
  }
}
