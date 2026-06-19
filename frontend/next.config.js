/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV !== 'production';

// Origin of the backend API (scheme://host:port), derived from the public API
// URL so the CSP connect-src can permit cross-origin XHR to it. Falls back to
// the local dev backend.
const API_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api').origin;
  } catch {
    return 'http://localhost:5000';
  }
})();

// Content-Security-Policy for the Next.js frontend.
//
// Why here and not in the Express backend?
// The backend serves only JSON API responses — CSP directives like scriptSrc
// and styleSrc are meaningless for JSON. The frontend (Next.js) renders HTML
// and is the correct place to enforce a browser-facing CSP.
//
// style-src needs 'unsafe-inline': the app styles its UI with inline <style>
// blocks and React style={{}} props, and Next.js injects global CSS inline in
// dev mode. Inline-style injection is low-risk compared to script injection,
// so we keep script-src strict ('self') while permitting inline styles. We
// also allow Google Fonts (fonts.googleapis.com stylesheet + gstatic webfonts).
//
// In development, script-src additionally needs 'unsafe-eval' for Next.js HMR.
const scriptSrc = isDev ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'";

const CSP = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com data:",
  // Allow fetch/XHR to the backend API and Stellar Horizon (testnet + mainnet).
  // The backend API origin is included so the browser can reach it cross-origin
  // in split-port deployments (e.g. localhost:3000 UI → localhost:5000 API).
  `connect-src 'self' ${API_ORIGIN} https://horizon-testnet.stellar.org https://horizon.stellar.org`,
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

// Server-side origin of the backend, used by the dev proxy (rewrites) below.
// Lets the browser call the API same-origin (/api/*) so cookies stay first-party
// — essential in split-host setups like GitHub Codespaces.
const BACKEND_ORIGIN = process.env.BACKEND_PROXY_TARGET || 'http://localhost:5000';

const nextConfig = {
  // Produces a self-contained build in .next/standalone — required for Docker
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  // Same-origin API proxy: browser → /api/* (this origin) → backend. Keeps
  // requests first-party so HttpOnly SameSite=Strict auth cookies are sent.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND_ORIGIN}/api/:path*` },
    ];
  },
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
