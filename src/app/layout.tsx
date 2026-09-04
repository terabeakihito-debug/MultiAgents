import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "MultiAgents", description: "Compare local AI CLI responses" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
