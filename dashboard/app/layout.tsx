import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "comux Dashboard",
  description: "Web control surface for the comux Harness",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
