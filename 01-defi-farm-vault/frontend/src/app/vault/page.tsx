'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useState} from 'react';
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api, formatUsd} from '@/lib/api';
import {cn} from '@/lib/cn';
import {contracts, erc20Abi, vaultAbi} from '@/lib/contracts';
import {formatPrice, formatRelativeTime, parseAmount} from '@/lib/format';

export default function VaultPage() {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');

  const {data: vault, isLoading, isError} = useQuery({
    queryKey: ['vault'],
    queryFn: api.vault,
    refetchInterval: 15_000,
    retry: false,
  });

  const {data: keeper} = useQuery({queryKey: ['keeperRuns'], queryFn: api.keeperRuns, retry: false});

  const {data: portfolio} = useQuery({
    queryKey: ['portfolio', address],
    queryFn: () => api.portfolio(address!),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });

  // The vault's asset is the LP token it farms, read from chain so the UI has no second source.
  const {data: lpBalance, refetch: refetchBalance} = useReadContract({
    address: (portfolio?.positions[0]?.pool.lpToken ?? contracts.rewardToken) as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {enabled: Boolean(address) && Boolean(portfolio?.positions[0])},
  });

  const {writeContract, data: hash, isPending, error, reset} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  const refresh = useCallback(() => {
    setAmount('');
    void refetchBalance();
    void queryClient.invalidateQueries({queryKey: ['vault']});
    void queryClient.invalidateQueries({queryKey: ['portfolio', address]});
  }, [queryClient, address, refetchBalance]);

  useEffect(() => {
    if (isSuccess) refresh();
  }, [isSuccess, refresh]);

  if (isError) {
    return (
      <p className="py-24 text-center text-neutral-500">
        No auto-compounding vault is deployed for this farm.
      </p>
    );
  }

  if (isLoading || !vault) {
    return <div className="h-64 animate-pulse rounded-xl bg-neutral-900" />;
  }

  const position = portfolio?.vault;
  const staked = BigInt(position?.assets ?? '0');
  const gain = BigInt(position?.unrealisedGain ?? '0');
  const parsed = parseAmount(amount);
  const busy = isPending || confirming;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Auto-compounding vault</h1>
        <p className="max-w-2xl text-neutral-400">
          Deposit LP once. The vault farms it, harvests rewards, swaps them into both sides of the
          pair, re-adds liquidity and restakes. Your share count stays the same; each share simply
          becomes worth more.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Total deposits</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatPrice(vault.totalAssets)} LP
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Share price</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatPrice(vault.pricePerShare)}
          </p>
          <p className="mt-1 text-xs text-neutral-600">Rises with every compound</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Last compound</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {vault.secondsSinceCompound < 3_600
              ? `${Math.round(vault.secondsSinceCompound / 60)}m ago`
              : `${Math.round(vault.secondsSinceCompound / 3_600)}h ago`}
          </p>
        </div>
      </div>

      {vault.paused && (
        <div className="card border-amber-900 bg-amber-950/20">
          <p className="text-amber-200">
            The vault is paused. Deposits and compounding are halted, but withdrawals remain open by
            design: a pause must never trap funds.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <div className="card space-y-4">
            <h2 className="font-medium">Your position</h2>

            {!address ? (
              <p className="py-6 text-center text-sm text-neutral-500">Connect a wallet.</p>
            ) : (
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-neutral-500">Value</dt>
                  <dd className="text-xl font-semibold tabular-nums">{formatPrice(staked)} LP</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Unrealised gain</dt>
                  <dd
                    className={cn(
                      'text-xl font-semibold tabular-nums',
                      gain > 0n ? 'text-emerald-400' : 'text-neutral-300',
                    )}
                  >
                    {gain > 0n ? '+' : ''}
                    {formatPrice(gain)} LP
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Shares</dt>
                  <dd className="tabular-nums">{formatPrice(position?.shares ?? '0')}</dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Cost basis</dt>
                  <dd className="tabular-nums">{formatPrice(position?.netDeposited ?? '0')}</dd>
                </div>
              </dl>
            )}
          </div>

          {/* Anyone can compound and take the bounty. Surfacing it makes the permissionless design
              visible rather than a claim in a README. */}
          <div className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">Compound now</h2>
                <p className="mt-1 text-sm text-neutral-400">
                  Anyone can trigger a compound and keep the bounty. Currently{' '}
                  <span className="tabular-nums text-emerald-400">
                    {formatPrice(vault.callerBounty)}
                  </span>{' '}
                  in reward tokens, from {formatPrice(vault.pendingRewards)} pending.
                </p>
              </div>

              <button
                type="button"
                className="btn-secondary"
                disabled={!address || busy || BigInt(vault.pendingRewards) === 0n || vault.paused}
                onClick={() => {
                  reset();
                  writeContract({
                    address: contracts.vault,
                    abi: vaultAbi,
                    functionName: 'compound',
                    // Two minute deadline, so a transaction stuck in the mempool cannot execute
                    // later at a price nobody agreed to.
                    args: [BigInt(Math.floor(Date.now() / 1000) + 120)],
                  });
                }}
              >
                {busy ? 'Compounding…' : 'Compound'}
              </button>
            </div>
          </div>

          {keeper && keeper.summary.enabled && (
            <div className="card space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="font-medium">Keeper activity</h2>
                <span className="text-xs text-neutral-500">
                  {keeper.summary.successes} compounded · {keeper.summary.skipped} skipped as
                  unprofitable
                </span>
              </div>

              <p className="text-sm text-neutral-500">
                An automated keeper compounds whenever the bounty is worth more than the gas. Its
                decisions are recorded either way, so a keeper quietly losing money would be visible
                here.
              </p>

              <ul className="divide-y divide-neutral-800 text-sm">
                {keeper.runs.slice(0, 6).map((run) => (
                  <li key={run.id} className="flex items-center justify-between py-2">
                    <span
                      className={cn(
                        run.outcome === 'SUCCESS'
                          ? 'text-emerald-400'
                          : run.outcome === 'FAILED'
                            ? 'text-red-400'
                            : 'text-neutral-500',
                      )}
                    >
                      {run.outcome === 'SUCCESS'
                        ? 'Compounded'
                        : run.outcome === 'FAILED'
                          ? 'Failed'
                          : 'Skipped, gas exceeded bounty'}
                    </span>
                    <span className="text-right text-xs text-neutral-600">
                      {run.bountyUsd && run.gasCostUsd && (
                        <span className="mr-2 tabular-nums">
                          {formatUsd(run.bountyUsd)} vs {formatUsd(run.gasCostUsd)} gas
                        </span>
                      )}
                      {formatRelativeTime(run.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="card space-y-4">
          <div className="flex gap-1 rounded-lg bg-neutral-900 p-1">
            {(['deposit', 'withdraw'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTab(value);
                  setAmount('');
                  reset();
                }}
                className={cn(
                  'flex-1 rounded-md px-3 py-2 text-sm font-medium capitalize transition-colors',
                  tab === value ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300',
                )}
              >
                {value}
              </button>
            ))}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="label mb-0">Amount (LP)</span>
              <button
                type="button"
                className="text-xs text-amber-400 hover:text-amber-300"
                onClick={() =>
                  setAmount(formatPrice(tab === 'deposit' ? (lpBalance ?? 0n) : staked))
                }
              >
                Max {formatPrice(tab === 'deposit' ? (lpBalance ?? 0n) : staked)}
              </button>
            </div>
            <input
              className="input tabular-nums"
              placeholder="0.00"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn-primary w-full"
            disabled={!address || !parsed || parsed === 0n || busy || (tab === 'deposit' && vault.paused)}
            onClick={() => {
              if (!address || !parsed) return;
              reset();

              if (tab === 'deposit') {
                writeContract({
                  address: contracts.vault,
                  abi: vaultAbi,
                  functionName: 'deposit',
                  args: [parsed, address],
                });
                return;
              }

              // Redeem by shares rather than withdrawing by assets. The share price moves between
              // quote and execution, so a "max" withdrawal expressed in assets can end up one wei
              // short and revert.
              const shares = BigInt(position?.shares ?? '0');
              const toRedeem = staked === 0n ? 0n : (parsed * shares) / staked;

              writeContract({
                address: contracts.vault,
                abi: vaultAbi,
                functionName: 'redeem',
                args: [toRedeem > shares ? shares : toRedeem, address, address],
              });
            }}
          >
            {!address
              ? 'Connect wallet'
              : busy
                ? 'Working…'
                : tab === 'deposit'
                  ? 'Deposit'
                  : 'Withdraw'}
          </button>

          {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
        </div>
      </div>
    </div>
  );
}
