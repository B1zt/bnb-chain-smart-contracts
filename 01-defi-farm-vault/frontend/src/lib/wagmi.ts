import {getDefaultConfig} from '@rainbow-me/rainbowkit';
import {bsc, bscTestnet, opBNB} from 'wagmi/chains';

import {defineChain} from 'viem';

/**
 * The local Anvil from `docker compose up`.
 *
 * Included so the whole stack runs offline: no faucet, no RPC key, no testnet block times. Leaving
 * it out meant the chain the project ships could not be selected, and every page rendered "wrong
 * network".
 */
const anvil = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: {name: 'BNB', symbol: 'BNB', decimals: 18},
  rpcUrls: {default: {http: [process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545']}},
  testnet: true,
});

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 97);

const chainsById = {
  [anvil.id]: anvil,
  [bsc.id]: bsc,
  [bscTestnet.id]: bscTestnet,
  [opBNB.id]: opBNB,
} as const;

export const activeChain = chainsById[chainId as keyof typeof chainsById] ?? bscTestnet;

export const wagmiConfig = getDefaultConfig({
  appName: 'B1zt BSC Farm',
  // WalletConnect needs a project id. Without one only injected wallets work, which is fine locally
  // but breaks mobile wallets in a real deployment.
  // `??` is not enough here: an unset variable in a .env file arrives as an empty string, not as
  // undefined, and RainbowKit throws on an empty project id. That turned "I have not signed up for
  // WalletConnect yet" into a 500 on every page, which is the worst possible first run.
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo',
  chains: [activeChain],
  ssr: true,
});
