'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import Link from 'next/link';
import {useEffect} from 'react';
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api, formatBps, formatUsd} from '@/lib/api';
import {contracts, masterChefAbi} from '@/lib/contracts';
import {formatPrice, formatRelativeTime, shortAddress} from '@/lib/format';

export default function PortfolioPage() {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const {data, isLoading} = useQuery({
    queryKey: ['portfolio', address],
    queryFn: () => api.portfolio(address!),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });

  const {data: activity} = useQuery({
    queryKey: ['activity', address],
    queryFn: () => api.activity({address: address!, limit: 25}),
    enabled: Boolean(address),
  });

  const {writeContract, data: hash, isPending, error} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  useEffect(() => {
    if (isSuccess) void queryClient.invalidateQueries({queryKey: ['portfolio', address]});
  }, [isSuccess, queryClient, address]);

  if (!address) {
    return <p className="py-24 text-center text-neutral-500">Connect a wallet to see your positions.</p>;
  }

  if (isLoading || !data) {
    return <div className="h-64 animate-pulse rounded-xl bg-neutral-900" />;
  }

  const totalPending = BigInt(data.totalPendingReward);
  const busy = isPending || confirming;

  // Only pools with something to claim, so the batch harvest does not waste gas on empty pools.
  const harvestable = data.positions
    .filter((position) => BigInt(position.pendingReward) > 0n && position.harvestUnlockIn === 0)
    .map((position) => BigInt(position.poolId));

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Portfolio</h1>
          <p className="mt-1 text-sm text-neutral-500">{shortAddress(address)}</p>
        </div>

        {harvestable.length > 0 && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() =>
              writeContract({
                address: contracts.masterChef,
                abi: masterChefAbi,
                functionName: 'harvestMany',
                args: [harvestable],
              })
            }
          >
            {busy
              ? 'Harvesting…'
              : `Harvest all ${formatPrice(totalPending)} from ${harvestable.length} pool${harvestable.length === 1 ? '' : 's'}`}
          </button>
        )}
      </header>

      {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Farm positions ({data.positions.length})</h2>

        {data.positions.length === 0 ? (
          <p className="text-neutral-600">Nothing staked yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900/50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3">Pool</th>
                  <th className="px-4 py-3">Staked</th>
                  <th className="px-4 py-3">APR</th>
                  <th className="px-4 py-3">Pending</th>
                  <th className="px-4 py-3">Harvested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {data.positions.map((position) => (
                  <tr key={position.poolId} className="hover:bg-neutral-900/40">
                    <td className="px-4 py-3">
                      <Link href="/farms" className="hover:text-white">
                        {position.pool.name ?? `Pool ${position.poolId}`}
                      </Link>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{formatPrice(position.amount)}</td>
                    <td className="px-4 py-3 tabular-nums text-amber-400">
                      {formatBps(position.pool.aprBps)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-emerald-400">
                      {formatPrice(position.pendingReward)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-neutral-400">
                      {formatPrice(position.totalHarvested)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.vault && BigInt(data.vault.shares) > 0n && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Auto-compounding vault</h2>
          <div className="card grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">Value</p>
              <p className="mt-1 tabular-nums">{formatPrice(data.vault.assets)} LP</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">Deposited</p>
              <p className="mt-1 tabular-nums">{formatPrice(data.vault.netDeposited)} LP</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">Gain</p>
              <p className="mt-1 tabular-nums text-emerald-400">
                +{formatPrice(data.vault.unrealisedGain)} LP
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">Shares</p>
              <p className="mt-1 tabular-nums">{formatPrice(data.vault.shares)}</p>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Recent activity</h2>

        {(activity?.activity.length ?? 0) === 0 ? (
          <p className="text-neutral-600">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-xl border border-neutral-800">
            {activity!.activity.map((event) => (
              <li key={event.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="capitalize">
                    {event.kind.toLowerCase().replace('_', ' ')}{' '}
                    <span className="text-neutral-500">{event.pool.name ?? `pool ${event.poolId}`}</span>
                  </p>
                  <p className="text-xs text-neutral-600">{formatRelativeTime(event.blockTime)}</p>
                </div>
                <span className="tabular-nums">{formatPrice(event.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
