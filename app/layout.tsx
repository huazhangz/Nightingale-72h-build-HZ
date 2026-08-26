import type { ReactNode } from "react";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import { CareShell } from "../src/components/care/CareShell";
import { I18nProvider } from "../src/lib/i18n/I18nContext";
import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-sans",
});

const serif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-serif",
});

export const metadata = {
  title: "Nightingale care notes",
  description: "Longitudinal patient notes for clinic teams",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${serif.variable}`}>
        <I18nProvider>
          <CareShell>{children}</CareShell>
        </I18nProvider>
      </body>
    </html>
  );
}
