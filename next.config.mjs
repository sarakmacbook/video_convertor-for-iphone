/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native / non-bundlable packages stay outside the server bundle.
  serverExternalPackages: ["pg", "mysql2", "@libsql/client", "@vercel/blob"],
  // When ffmpeg-static / ffprobe-static are installed, their binaries have to be traced into the
  // serverless functions as well — `lib/encoding/ffmpeg.ts` looks them up by name at runtime.
  // Without those packages the globs simply match nothing.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/ffmpeg-static/**", "./node_modules/ffprobe-static/**"],
  },
  // Videos are never inlined into the client bundle, and uploads go straight to storage.
  experimental: {
    serverActions: {
      // Not used for uploads (they go to storage), kept small on purpose.
      bodySizeLimit: "2mb",
    },
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    // `lib/encoding/ffmpeg.ts` looks up optional packages (ffmpeg-static, ffprobe-static) by
    // name at runtime, which webpack cannot resolve statically. That is deliberate: the app
    // works without them.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /lib[\\/]encoding[\\/]ffmpeg/, message: /Critical dependency/ },
    ];
    return config;
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
