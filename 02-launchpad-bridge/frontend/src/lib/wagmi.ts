import {getDefaultConfig} from '@rainbow-me/rainbowkit';
import {bsc, bscTestnet, opBNB} from 'wagmi/chains';

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 97);

const chainsById = {
  [bsc.id]: bsc,
  [bscTestnet.id]: bscTestnet,
  [opBNB.id]: opBNB,
} as const;

export const activeChain = chainsById[chainId as keyof typeof chainsById] ?? bscTestnet;

export const wagmiConfig = getDefaultConfig({
  appName: 'B1zt Launchpad',
  // WalletConnect needs a project id. Without one only injected wallets work, which is fine locally
  // but breaks mobile wallets in a real deployment.
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'demo',
  chains: [activeChain],
  ssr: true,
});
