'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useState} from 'react';
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api, formatBps, formatUsd, type Pool} from '@/lib/api';
import {cn} from '@/lib/cn';
import {contracts, erc20Abi, masterChefAbi} from '@/lib/contracts';
import {formatCountdown, formatPrice, parseAmount} from '@/lib/format';

/**
 * One farm pool: stake, unstake, harvest.
 *
 * Pending rewards are polled rather than cached: they increase every second, so a stale figure
 * makes the UI look frozen and, worse, invites a harvest transaction for an amount that no longer
 * matches. Six seconds matches BSC's block time closely enough.
 */
export function FarmCard({pool, rewardSymbol}: {pool: Pool; rewardSymbol: string}) {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const [expanded, setExpanded] = useState(false);
  const [stakeInput, setStakeInput] = useState('');
  const [unstakeInput, setUnstakeInput] = useState('');

  const {data: position} = useQuery({
    queryKey: ['position', pool.id, address],
    queryFn: () => api.position(pool.id, address!),
    enabled: Boolean(address),
    refetchInterval: 6_000,
  });

  const {data: lpBalance, refetch: refetchBalance} = useReadContract({
    address: pool.lpToken as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {data: allowance, refetch: refetchAllowance} = useReadContract({
    address: pool.lpToken as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contracts.masterChef] : undefined,
    query: {enabled: Boolean(address)},
  });

  const {writeContract, data: hash, isPending, error, reset} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  const refresh = useCallback(() => {
    setStakeInput('');
    setUnstakeInput('');
    void refetchBalance();
    void refetchAllowance();
    void queryClient.invalidateQueries({queryKey: ['position', pool.id, address]});
    void queryClient.invalidateQueries({queryKey: ['pools']});
  }, [queryClient, pool.id, address, refetchBalance, refetchAllowance]);

  useEffect(() => {
    if (isSuccess) refresh();
  }, [isSuccess, refresh]);

  const staked = BigInt(position?.amount ?? '0');
  const pending = BigInt(position?.pendingReward ?? '0');
  const unlockIn = position?.harvestUnlockIn ?? 0;

  const stakeWei = parseAmount(stakeInput);
  const unstakeWei = parseAmount(unstakeInput);

  const needsApproval = stakeWei !== null && (allowance ?? 0n) < stakeWei;
  const busy = isPending || confirming;

  const call = (functionName: 'deposit' | 'withdraw', amount: bigint) => {
    reset();
    writeContract({
      address: contracts.masterChef,
      abi: masterChefAbi,
      functionName,
      args: [BigInt(pool.id), amount],
    });
  };

  return (
    <div className="card space-y-4">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="grid w-full grid-cols-2 items-center gap-4 text-left sm:grid-cols-5"
      >
        <div className="col-span-2 sm:col-span-1">
          <p className="font-medium">{pool.name ?? `Pool ${pool.id}`}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {pool.depositFeeBps > 0 && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
                {formatBps(pool.depositFeeBps, 1)} fee
              </span>
            )}
            {pool.harvestLockup > 0 && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
                {Math.round(pool.harvestLockup / 3_600)}h lock
              </span>
            )}
            {!pool.isActive && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-500">
                inactive
              </span>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">APR</p>
          <p className="tabular-nums text-amber-400">{formatBps(pool.aprBps)}</p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">TVL</p>
          <p className="tabular-nums">{formatUsd(pool.tvlUsd)}</p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">Staked</p>
          <p className="tabular-nums">{formatPrice(staked)}</p>
        </div>

        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Earned</p>
          <p className="tabular-nums text-emerald-400">{formatPrice(pending)}</p>
        </div>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-neutral-800 pt-4">
          {!address ? (
            <p className="py-4 text-center text-sm text-neutral-500">Connect a wallet to farm.</p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {/* Stake */}
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="label mb-0">Stake LP</span>
                    <button
                      type="button"
                      className="text-xs text-amber-400 hover:text-amber-300"
                      onClick={() => setStakeInput(formatPrice(lpBalance ?? 0n))}
                    >
                      Max {formatPrice(lpBalance ?? 0n)}
                    </button>
                  </div>
                  <input
                    className="input tabular-nums"
                    placeholder="0.00"
                    inputMode="decimal"
                    value={stakeInput}
                    onChange={(event) => setStakeInput(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-primary w-full"
                    disabled={!stakeWei || stakeWei === 0n || busy}
                    onClick={() => {
                      if (!stakeWei) return;

                      if (needsApproval) {
                        reset();
                        writeContract({
                          address: pool.lpToken as `0x${string}`,
                          abi: erc20Abi,
                          functionName: 'approve',
                          args: [contracts.masterChef, 2n ** 256n - 1n],
                        });
                        return;
                      }

                      call('deposit', stakeWei);
                    }}
                  >
                    {busy ? 'Working…' : needsApproval ? 'Approve LP' : 'Stake'}
                  </button>
                  {pool.depositFeeBps > 0 && stakeWei && (
                    <p className="text-xs text-neutral-500">
                      A {formatBps(pool.depositFeeBps, 1)} deposit fee applies, so{' '}
                      {formatPrice((stakeWei * BigInt(10_000 - pool.depositFeeBps)) / 10_000n)} is
                      credited.
                    </p>
                  )}
                </div>

                {/* Unstake */}
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="label mb-0">Unstake LP</span>
                    <button
                      type="button"
                      className="text-xs text-amber-400 hover:text-amber-300"
                      onClick={() => setUnstakeInput(formatPrice(staked))}
                    >
                      Max {formatPrice(staked)}
                    </button>
                  </div>
                  <input
                    className="input tabular-nums"
                    placeholder="0.00"
                    inputMode="decimal"
                    value={unstakeInput}
                    onChange={(event) => setUnstakeInput(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    disabled={!unstakeWei || unstakeWei === 0n || unstakeWei > staked || busy}
                    onClick={() => unstakeWei && call('withdraw', unstakeWei)}
                  >
                    {busy ? 'Working…' : 'Unstake'}
                  </button>
                </div>
              </div>

              {/* Harvest */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-neutral-500">
                    {rewardSymbol} earned
                  </p>
                  <p className="text-lg font-semibold tabular-nums text-emerald-400">
                    {formatPrice(pending)}
                  </p>
                  {unlockIn > 0 && (
                    <p className="mt-0.5 text-xs text-amber-400">
                      Harvest unlocks in {formatCountdown(Date.now() + unlockIn * 1000) ?? 'moments'}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  className={cn('btn-primary', (pending === 0n || unlockIn > 0) && 'opacity-50')}
                  disabled={pending === 0n || unlockIn > 0 || busy}
                  onClick={() => {
                    reset();
                    writeContract({
                      address: contracts.masterChef,
                      abi: masterChefAbi,
                      functionName: 'harvest',
                      args: [BigInt(pool.id)],
                    });
                  }}
                >
                  {busy ? 'Harvesting…' : 'Harvest'}
                </button>
              </div>

              {/* Emergency withdraw. Deliberately understated and explained, because it forfeits
                  rewards, but it must be reachable: it is the path that still works when the reward
                  token itself is broken. */}
              {staked > 0n && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-neutral-600 hover:text-neutral-400">
                    Emergency withdraw
                  </summary>
                  <div className="mt-2 space-y-2 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
                    <p className="text-red-300">
                      Withdraws your full stake immediately and <strong>forfeits all pending
                      rewards</strong>. It touches no reward accounting, so it works even if the
                      reward token is broken.
                    </p>
                    <button
                      type="button"
                      className="btn border border-red-800 text-red-300 hover:bg-red-950/40"
                      disabled={busy}
                      onClick={() => {
                        reset();
                        writeContract({
                          address: contracts.masterChef,
                          abi: masterChefAbi,
                          functionName: 'emergencyWithdraw',
                          args: [BigInt(pool.id)],
                        });
                      }}
                    >
                      Emergency withdraw {formatPrice(staked)} LP
                    </button>
                  </div>
                </details>
              )}

              {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
