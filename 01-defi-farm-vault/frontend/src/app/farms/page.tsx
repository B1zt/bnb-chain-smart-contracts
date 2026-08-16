'use client';

import {useQuery} from '@tanstack/react-query';
import {useState} from 'react';
import {useAccount, useReadContract} from 'wagmi';
import {FarmCard} from '@/components/FarmCard';
import {api, formatUsd} from '@/lib/api';
import {cn} from '@/lib/cn';
import {contracts, erc20Abi} from '@/lib/contracts';

export default function FarmsPage() {
  const {address} = useAccount();
  const [sort, setSort] = useState<'apr' | 'tvl' | 'id'>('apr');
  const [activeOnly, setActiveOnly] = useState(true);

  const {data, isLoading} = useQuery({
    queryKey: ['pools', sort, activeOnly],
    queryFn: () => api.pools({sort, activeOnly}),
    refetchInterval: 30_000,
  });

  const {data: rewardSymbol} = useReadContract({
    address: contracts.rewardToken,
    abi: erc20Abi,
    functionName: 'symbol',
  });

  const pools = data?.pools ?? [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Farms</h1>
          <p className="max-w-2xl text-neutral-400">
            Stake LP tokens to earn {rewardSymbol ?? 'rewards'}. Emissions are per second, so a
            change in BNB Chain&apos;s block time does not quietly rewrite the schedule.
          </p>
        </div>

        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Total value locked</p>
          <p className="text-2xl font-semibold tabular-nums">{formatUsd(data?.totalTvlUsd ?? null)}</p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-neutral-900 p-1">
          {(['apr', 'tvl', 'id'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSort(value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm uppercase transition-colors',
                sort === value ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {value}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(event) => setActiveOnly(event.target.checked)}
            className="h-4 w-4 rounded border-neutral-700 bg-neutral-900"
          />
          Active only
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({length: 4}, (_unused, index) => (
            <div key={index} className="h-24 animate-pulse rounded-xl bg-neutral-900" />
          ))}
        </div>
      ) : pools.length === 0 ? (
        <p className="py-16 text-center text-neutral-600">No pools configured yet.</p>
      ) : (
        <div className="space-y-3">
          {pools.map((pool) => (
            <FarmCard key={pool.id} pool={pool} rewardSymbol={rewardSymbol ?? 'FARM'} />
          ))}
        </div>
      )}

      {!address && (
        <p className="text-center text-sm text-neutral-600">
          Connect a wallet to see your positions and stake.
        </p>
      )}
    </div>
  );
}
