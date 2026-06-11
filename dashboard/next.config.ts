import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: [],
  // comux core imports parent ../src — keep them external so Bun APIs survive bundling.
  serverExternalPackages: ["elysia"],
  experimental: {
    externalDir: true,
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingRoot: join(import.meta.dirname, ".."),
};

export default nextConfig;
