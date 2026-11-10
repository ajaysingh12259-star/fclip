import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "fclip — Free Online Video Clipper (up to 4K)",
  description:
    "Paste a YouTube link, pick the exact seconds, and download just that clip in up to 4K — free, no account, no watermark. fclip streams only the byte-ranges it needs, never the whole file.",
  keywords: ["fclip", "video clipper", "YouTube cutter", "trim video online", "yt-dlp", "ffmpeg", "4K clip"],
  icons: {
    icon: "/fclip.svg",
  },
  openGraph: {
    title: "fclip — Free Online Video Clipper",
    description: "Cut YouTube clips online and download up to 4K, without downloading the whole video.",
    siteName: "fclip",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
