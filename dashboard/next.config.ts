import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: [],
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: join(import.meta.dirname, ".."),
};

export default nextConfig;
