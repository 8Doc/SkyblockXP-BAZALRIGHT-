export function coins(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";

  // Costs are never negative, but a margin is: instabuying the ingredients and instaselling the
  // output usually loses money, and that is the point of showing it. Scale the size and put the
  // sign back afterwards, or a loss of 19M renders as "-18997815".
  const sign = n < 0 ? "−" : "";
  const size = Math.abs(n);

  // Round into the unit first, or 999,999 renders as "1000k" instead of "1M".
  for (const [scale, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    const scaled = size / scale;
    if (scaled >= 0.9995) {
      const digits = scaled < 10 ? (suffix === "B" ? 2 : 1) : 0;
      return `${sign}${scaled.toFixed(digits)}${suffix}`;
    }
  }
  return `${sign}${Math.round(size)}`;
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Coins per XP, the ranking number. */
export function rate(n: number | null): string {
  if (n === null) return "—";
  return `${coins(n)}/xp`;
}
