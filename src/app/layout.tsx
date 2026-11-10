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
  title: "fclip — Cut YouTube Clips Online, No Cookies Needed (up to 4K)",
  description:
    "Paste a YouTube link, pick the exact seconds, and download just that clip in up to 4K — free, no account, no cookies required, no watermark. fclip streams only the byte-ranges it needs and falls back to its relay network when YouTube walls the server.",
  keywords: [
    "fclip",
    "video clipper",
    "YouTube cutter",
    "trim video online",
    "yt-dlp",
    "ffmpeg",
    "4K clip",
    "youtube clipper no cookies",
    "youtube trimmer",
  ],
  icons: {
    icon: "/fclip.svg",
  },
  openGraph: {
    title: "fclip — Cut YouTube Clips Online, No Cookies Needed",
    description:
      "Cut YouTube clips online and download up to 4K, without downloading the whole video — and without logging in.",
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
