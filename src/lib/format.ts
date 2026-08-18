export function coins(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  // Round into the unit first, or 999,999 renders as "1000k" instead of "1M".
  for (const [scale, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    const scaled = n / scale;
    if (scaled >= 0.9995) {
      const digits = scaled < 10 ? (suffix === "B" ? 2 : 1) : 0;
      return `${scaled.toFixed(digits)}${suffix}`;
    }
  }
  return `${Math.round(n)}`;
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Coins per XP, the ranking number. */
export function rate(n: number | null): string {
  if (n === null) return "—";
  return `${coins(n)}/xp`;
}
