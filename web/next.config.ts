import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow verification builds to avoid the running dev server's output directory.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  // libSQL ships a native SQLite binding for local files; keep it out of the bundle.
  serverExternalPackages: ["@libsql/client", "libsql"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
