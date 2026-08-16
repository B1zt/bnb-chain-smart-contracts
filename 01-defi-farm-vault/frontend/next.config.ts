import type {NextConfig} from 'next';

/**
 * Optional peer dependencies that RainbowKit drags in transitively.
 *
 * The chain is RainbowKit -> wagmi/connectors -> @base-org/account -> @coinbase/cdp-sdk, which
 * statically imports Coinbase's x402 payment protocol packages without declaring them as hard
 * dependencies. Under pnpm's strict node_modules layout they are simply absent, and webpack treats
 * an unresolvable static import as fatal even when the code path never runs.
 *
 * This marketplace does not use Coinbase Smart Wallet payments, so resolving them to an empty
 * module is the correct outcome rather than a workaround. Installing them instead would pull in
 * several megabytes of dependency for code that never executes.
 */
const UNUSED_OPTIONAL_MODULES = [
  '@x402/core/client',
  '@x402/evm',
  '@x402/evm/exact/client',
  '@x402/evm/upto/client',
  '@x402/svm/exact/client',
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Token art is served from arbitrary IPFS gateways whose hostnames are not knowable at build
  // time, and the optimiser requires every remote host to be allowlisted up front.
  images: {unoptimized: true},

  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(UNUSED_OPTIONAL_MODULES.map((name) => [name, false])),
    };
    return config;
  },

  turbopack: {
    // Turbopack has no `false` sentinel, so the same imports point at a local empty module.
    resolveAlias: Object.fromEntries(
      UNUSED_OPTIONAL_MODULES.map((name) => [name, './src/lib/empty-module.ts']),
    ),
  },
};

export default nextConfig;
