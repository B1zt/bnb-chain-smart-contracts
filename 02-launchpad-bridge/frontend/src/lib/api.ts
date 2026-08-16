const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4003/api/v1';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {'Content-Type': 'application/json'},
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as {error: unknown}).error)
        : `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

export type PresaleStatus = 'PENDING' | 'LIVE' | 'SUCCEEDED' | 'FAILED' | 'FINALISED';

export interface Presale {
  address: string;
  creator: string;
  token: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenDecimals: number;
  tokensPerUsd: string;
  softCapUsd: string;
  hardCapUsd: string;
  minContributionUsd: string;
  maxContributionUsd: string;
  startTime: string;
  endTime: string;
  tierRoot: string;
  raisedUsd: string;
  contributorCount: number;
  status: PresaleStatus;
  isVerified: boolean;
  progressBps: number;
  softCapReached: boolean;
}

export interface Lock {
  id: string;
  token: string;
  tokenSymbol: string | null;
  owner: string;
  amount: string;
  lockedAt: string;
  unlockAt: string;
  withdrawn: boolean;
  description: string;
}

export interface PresalePosition {
  contributedUsd: string;
  tokenAllocation: string;
  hasClaimed: boolean;
  tier: {allowanceUsd: string} | null;
}

export interface TierProof {
  address: string;
  allowanceUsd: string;
  proof: `0x${string}`[];
  root: string;
}

export type TransferStatus =
  | 'OBSERVED'
  | 'CONFIRMED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'DELAYED'
  | 'FAILED';

export interface BridgeTransfer {
  messageHash: string;
  sourceChainId: number;
  destinationChainId: number;
  token: string;
  sender: string;
  recipient: string;
  amount: string;
  status: TransferStatus;
  sourceTxHash: string;
  destinationTxHash: string | null;
  confirmations: number;
  requiredConfirmations?: number;
  signatureCount: number;
  requiredSignatures: number;
  executableAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export const api = {
  config: () =>
    request<{
      chainId: number;
      factory: string;
      locker: string;
      priceFeed: string | null;
      bridge: {
        enabled: boolean;
        sourceChainId: number;
        destinationChainId: number;
        sourceBridge: string | null;
        destinationBridge: string | null;
      };
    }>('/config'),

  presales: (params: {status?: PresaleStatus; verifiedOnly?: boolean} = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.verifiedOnly) query.set('verifiedOnly', 'true');

    return request<{presales: Presale[]; nextCursor: string | null}>(`/presales?${query}`);
  },

  presale: (address: string) =>
    request<{
      presale: Presale & {
        contributions: {
          id: string;
          contributor: string;
          usdValue: string;
          blockTime: string;
        }[];
      };
      locks: Lock[];
    }>(`/presales/${address}`),

  position: (address: string, wallet: string) =>
    request<PresalePosition>(`/presales/${address}/position/${wallet}`),

  /** Returns null when the sale is open rather than gated, which is a normal state. */
  tierProof: async (address: string, wallet: string): Promise<TierProof | null> => {
    try {
      return await request<TierProof>(`/presales/${address}/tiers/${wallet}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  locks: (token: string) =>
    request<{locks: Lock[]; totalLocked: string; activeLocks: number}>(`/locks/${token}`),

  bridgeStatus: () =>
    request<{
      enabled: boolean;
      paused?: boolean | null;
      onChainThreshold?: number | null;
      validatorCount?: number | null;
      thresholdMatchesConfig?: boolean | null;
      pendingTransfers?: number;
      failedTransfers?: number;
    }>('/bridge/status'),

  transfers: (params: {address?: string; status?: TransferStatus} = {}) => {
    const query = new URLSearchParams();
    if (params.address) query.set('address', params.address);
    if (params.status) query.set('status', params.status);

    return request<{transfers: BridgeTransfer[]}>(`/bridge/transfers?${query}`);
  },

  transfer: (messageHash: string) =>
    request<{transfer: BridgeTransfer}>(`/bridge/transfers/${messageHash}`),
};

/** USD values arrive at 18 decimals. */
export function formatUsd(value: string | null | undefined): string {
  if (!value) return '$0';

  const amount = Number(BigInt(value) / 10n ** 12n) / 1e6;

  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;

  return `$${amount.toFixed(2)}`;
}

/** Human-readable label for each stage of a cross-chain transfer. */
export const TRANSFER_STAGE: Record<TransferStatus, string> = {
  OBSERVED: 'Waiting for confirmations on the source chain',
  CONFIRMED: 'Collecting validator signatures',
  SIGNED: 'Ready to submit on the destination chain',
  SUBMITTED: 'Submitted, waiting for the destination receipt',
  DELAYED: 'Held by the large-transfer delay',
  COMPLETED: 'Delivered',
  FAILED: 'Failed',
};
