import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Gateway Control",
  description: "Enterprise AI Gateway management console",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
