import type { NextConfig } from "next";
import { join } from "node:path";

// Bun serves /api on PORT; Next dev listens on PORT+1. Proxy so :62121 can reach the API.
const apiPort = Number(
  process.env.COMUX_DASHBOARD_PORT ?? process.env.PORT ?? 62120,
);

const nextConfig: NextConfig = {
  transpilePackages: [],
  // comux core imports parent ../src — keep them external so Bun APIs survive bundling.
  serverExternalPackages: ["elysia"],
  experimental: {
    externalDir: true,
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingRoot: join(import.meta.dirname, ".."),
  allowedDevOrigins: ["ssh.perbstack.com"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${apiPort}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
