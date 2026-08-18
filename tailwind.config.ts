import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0e14",
        panel: "#141821",
        panel2: "#1b2029",
        line: "#272d3a",
        muted: "#8b94a7",
        gold: "#f0c674",
        aqua: "#5fd3bc",
        rose: "#e06c75",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
