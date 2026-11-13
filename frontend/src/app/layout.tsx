import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Newsreader } from "next/font/google";
import { Suspense } from "react";
import { Header } from "@/components/header";
import { PRODUCT_NAME, THEME_KEY } from "@/lib/constants";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });
const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: "What ran, what broke, why, and what is waiting on a person.",
};

// Sets the theme before the first paint, so dark mode doesn't flash light.
const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable} ${newsreader.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-canvas text-ink">
        <Suspense fallback={<div className="min-h-[60px] border-b border-line bg-surface" />}>
          <Header />
        </Suspense>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
