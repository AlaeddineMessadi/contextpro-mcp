import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ContextPro Dashboard",
  description: "Live operational dashboard for the ContextPro MCP server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
