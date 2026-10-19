import type { Metadata } from "next";
import { Martian_Mono, Public_Sans } from "next/font/google";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";
import { attempt, readNetwork, service } from "@/lib/services";
import { ParticipantNav } from "./nav";
import "./globals.css";

// Big Shoulders is self-hosted (SIL OFL 1.1, fonts/OFL-big-shoulders.txt): Latin, variable weight and optical size.
const display = localFont({
  src: "./fonts/big-shoulders.woff2",
  variable: "--font-display",
  weight: "100 900",
  adjustFontFallback: false,
  fallback: ["Arial Narrow", "sans-serif"],
});
const stencil = localFont({
  src: "./fonts/big-shoulders-stencil.woff2",
  variable: "--font-stencil",
  weight: "800",
  adjustFontFallback: false,
  fallback: ["Arial Narrow", "sans-serif"],
});
const body = Public_Sans({ subsets: ["latin"], variable: "--font-body" });
const figures = Martian_Mono({ subsets: ["latin"], variable: "--font-figures", axes: ["wdth"] });

export const metadata: Metadata = {
  title: "Open Unified Ledger console",
  description: "Each participant's books, instructions and reconciliation on the shared ledger.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const network = await attempt(readNetwork());
  return (
    <html lang="en" className={`${display.variable} ${stencil.variable} ${body.variable} ${figures.variable}`}>
      <body>
        <div className="frame">
          <aside className="rail">
            <Link href="/" className="wordmark">
              Open Unified <span>Ledger</span>
            </Link>
            {network.ok ? (
              <p className="rail-scenario">
                {network.value.scenario.name}
                <span>
                  {network.value.scenario.currencies.join(" · ")} · chain {network.value.deployment.chainId}
                </span>
              </p>
            ) : (
              <p className="rail-scenario">
                No participant services
                <span>start them to see each view</span>
              </p>
            )}
            <ParticipantNav
              participants={
                network.ok
                  ? await Promise.all(
                      network.value.participants.map(async (p) => ({
                        id: p.id,
                        name: p.name,
                        kind: p.kind,
                        agent: p.agent ? (network.value.participants.find((a) => a.id === p.agent)?.name ?? p.agent) : null,
                        reconciled: p.url ? await attempt(service(p).health()).then((h) => (h.ok ? h.value.reconciled : "down")) : null,
                      })),
                    )
                  : []
              }
            />
          </aside>
          <main className="desk">{children}</main>
        </div>
      </body>
    </html>
  );
}
