import type { Metadata } from "next";
import localFont from "next/font/local";
import { SidebarStateProvider } from "@/components/docs/sidebar-state";
import "./globals.css";
import "@/components/docs/documentation.css";

const inter = localFont({
  src: "../../public/docs/fonts/inter-latin.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
});

const paperMono = localFont({
  src: "../../public/docs/fonts/paper-mono-variable.woff2",
  variable: "--font-paper-mono",
  display: "swap",
  weight: "100 800",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://harness-docs-emb10.vercel.app"),
  title: { default: "Harness documentation", template: "%s — Harness" },
  description: "Install and configure Harness skills, hooks, command-line tools and extensions for Claude Code, ChatGPT and Pi.",
  icons: { icon: "/assets/harness_logo_black_transparent.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${paperMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: `try{const t=localStorage.getItem('harness-theme')||'system';document.documentElement.classList.toggle('dark',t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches))}catch{}` }} />
        <SidebarStateProvider>{children}</SidebarStateProvider>
      </body>
    </html>
  );
}
