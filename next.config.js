/** @type {import('next').NextConfig} */
const nextConfig = {
  /// start
  swcMinify: false,
  experimental: {
    serverMinification: false,
  },
  webpack: (config) => {
    config.optimization.minimize = false;
    return config;
  },
  compress: false,
  /// end

  poweredByHeader: false,
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
