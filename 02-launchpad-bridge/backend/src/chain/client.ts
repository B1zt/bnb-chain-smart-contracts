import {createPublicClient, http, type PublicClient} from 'viem';
import {bsc, bscTestnet, foundry, mainnet, opBNB, sepolia} from 'viem/chains';
import {config} from '../config.js';

const supportedChains = {
  // Local Anvil. The project ships one in docker-compose, so leaving it out would mean the
  // documented zero-config setup could not actually start.
  [foundry.id]: foundry,
  [bsc.id]: bsc,
  [bscTestnet.id]: bscTestnet,
  [opBNB.id]: opBNB,
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
} as const;

function resolveChain(chainId: number) {
  const chain = supportedChains[chainId as keyof typeof supportedChains];
  if (!chain) {
    throw new Error(`Unsupported chain id ${chainId}. Add it to supportedChains in chain/client.ts.`);
  }
  return chain;
}

/**
 * Clients are cached per chain id.
 *
 * The relayer spans two chains and touches each many times per pass. Building a fresh client per
 * call would discard viem's multicall batching between reads, which is the main thing keeping this
 * affordable against a rate-limited public RPC.
 */
const clients = new Map<number, PublicClient>();

function rpcFor(chainId: number): string {
  if (chainId === config.SOURCE_CHAIN_ID && config.SOURCE_RPC_URL) return config.SOURCE_RPC_URL;
  if (chainId === config.DESTINATION_CHAIN_ID && config.DESTINATION_RPC_URL) {
    return config.DESTINATION_RPC_URL;
  }
  if (chainId === config.CHAIN_ID) return config.RPC_URL;

  throw new Error(`No RPC URL configured for chain ${chainId}`);
}

/** Read-only client for a chain, created once and reused. */
export function clientFor(chainId: number): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;

  const client = createPublicClient({
    chain: resolveChain(chainId),
    transport: http(rpcFor(chainId), {retryCount: 3, retryDelay: 250, timeout: 20_000}),
    batch: {multicall: {wait: 16}},
  }) as PublicClient;

  clients.set(chainId, client);
  return client;
}

/** Client for the launchpad's own chain. */
export function publicClient(): PublicClient {
  return clientFor(config.CHAIN_ID);
}

export async function getHeadBlock(chainId: number = config.CHAIN_ID): Promise<bigint> {
  return clientFor(chainId).getBlockNumber();
}

/**
 * Highest block considered final on a chain.
 *
 * Everything at or below this is safe to persist; anything above may still be reorganised out and
 * is re-scanned on the next pass.
 */
export async function getSafeBlock(chainId: number = config.CHAIN_ID): Promise<bigint> {
  const head = await getHeadBlock(chainId);
  const confirmations = BigInt(config.CONFIRMATIONS);
  return head > confirmations ? head - confirmations : 0n;
}
