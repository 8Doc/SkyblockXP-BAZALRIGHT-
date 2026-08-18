import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SkyBlock XP Planner",
  description: "The cheapest way to the next N SkyBlock XP, grouped by category.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
