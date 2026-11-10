import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* Hide the Next.js dev-tools button in dev mode */
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
