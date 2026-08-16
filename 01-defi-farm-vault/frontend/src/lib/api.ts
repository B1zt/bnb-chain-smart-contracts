const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4002/api/v1';

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

export interface Pool {
  id: number;
  lpToken: string;
  name: string | null;
  token0Symbol: string | null;
  token1Symbol: string | null;
  allocPoint: string;
  depositFeeBps: number;
  harvestLockup: number;
  lpSupply: string;
  tvlUsd: string | null;
  aprBps: number;
  apyBps: number;
  isActive: boolean;
}

export interface PoolPosition {
  poolId: number;
  address: string;
  amount: string;
  pendingReward: string;
  harvestUnlockIn: number;
  totalHarvested: string;
}

export interface VaultStats {
  address: string;
  totalAssets: string;
  totalShares: string;
  pricePerShare: string;
  pendingRewards: string;
  callerBounty: string;
  secondsSinceCompound: number;
  paused: boolean;
}

export interface FarmActivity {
  id: string;
  poolId: number;
  address: string;
  kind: string;
  amount: string;
  fee: string;
  blockTime: string;
  txHash: string;
  pool: {name: string | null};
}

export interface KeeperRun {
  id: string;
  txHash: string | null;
  outcome: 'SUCCESS' | 'SKIPPED_UNPROFITABLE' | 'FAILED';
  expectedBounty: string;
  bountyUsd: string | null;
  gasCostUsd: string | null;
  error: string | null;
  createdAt: string;
}

export const api = {
  config: () =>
    request<{
      chainId: number;
      rewardToken: string;
      masterChef: string;
      oracle: string | null;
      vault: string | null;
      router: string;
      keeperEnabled: boolean;
    }>('/config'),

  pools: (params: {activeOnly?: boolean; sort?: 'apr' | 'tvl' | 'id'} = {}) => {
    const query = new URLSearchParams();
    if (params.activeOnly) query.set('activeOnly', 'true');
    if (params.sort) query.set('sort', params.sort);

    return request<{pools: Pool[]; totalTvlUsd: string}>(`/pools?${query}`);
  },

  pool: (id: number) =>
    request<{
      pool: Pool;
      stakerCount: number;
      history: {tvlUsd: string | null; aprBps: number; capturedAt: string}[];
    }>(`/pools/${id}`),

  position: (poolId: number, address: string) =>
    request<PoolPosition>(`/pools/${poolId}/position/${address}`),

  portfolio: (address: string) =>
    request<{
      address: string;
      positions: (PoolPosition & {pool: Pool})[];
      totalPendingReward: string;
      vault: {
        shares: string;
        assets: string;
        netDeposited: string;
        unrealisedGain: string;
      } | null;
    }>(`/portfolio/${address}`),

  activity: (params: {poolId?: number; address?: string; limit?: number} = {}) => {
    const query = new URLSearchParams();
    if (params.poolId !== undefined) query.set('poolId', String(params.poolId));
    if (params.address) query.set('address', params.address);
    if (params.limit) query.set('limit', String(params.limit));

    return request<{activity: FarmActivity[]; nextCursor: string | null}>(`/activity?${query}`);
  },

  vault: () => request<VaultStats>('/vault'),

  vaultHistory: () =>
    request<{snapshots: {pricePerShare: string; capturedAt: string}[]}>('/vault/history'),

  keeperRuns: () =>
    request<{
      runs: KeeperRun[];
      summary: {successes: number; skipped: number; failures: number; enabled: boolean};
    }>('/keeper/runs'),
};

/** Basis points to a percentage string. */
export function formatBps(bps: number, decimals = 2): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}

/** USD values arrive at 18 decimals from the oracle. */
export function formatUsd(value: string | null): string {
  if (value === null) return '-';

  const amount = Number(BigInt(value) / 10n ** 12n) / 1e6;

  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;

  return `$${amount.toFixed(2)}`;
}
