/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Staging + production are distinguished by env, not code (TSD §3A.3 three-env model).
  env: {
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV ?? 'development',
  },
};

export default nextConfig;
