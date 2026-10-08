import type { Metadata } from "next";

import { Nav } from "@/components/nav";
import { StatusBanner } from "@/components/status-banner";

import "./globals.css";

export const metadata: Metadata = {
  title: "iPhone video converter",
  description:
    "Shrink iPhone videos to HEVC without changing how they look. Web UI, API and Telegram webhook, deployable on Vercel with any SQL database.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Nav />
          <StatusBanner />
          {children}
        </div>
      </body>
    </html>
  );
}
