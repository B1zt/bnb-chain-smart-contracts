'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {use, useCallback, useEffect, useState} from 'react';
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api, formatUsd, type PresaleStatus} from '@/lib/api';
import {cn} from '@/lib/cn';
import {presaleAbi} from '@/lib/contracts';
import {formatCountdown, formatPrice, formatRelativeTime, parseAmount, shortAddress} from '@/lib/format';

const STATUS_STYLES: Record<PresaleStatus, string> = {
  PENDING: 'bg-neutral-800 text-neutral-300',
  LIVE: 'bg-emerald-500/15 text-emerald-300',
  SUCCEEDED: 'bg-amber-500/15 text-amber-300',
  FAILED: 'bg-red-500/15 text-red-300',
  FINALISED: 'bg-emerald-500/15 text-emerald-300',
};

export default function PresalePage({params}: {params: Promise<{address: string}>}) {
  const {address} = use(params);
  const {address: wallet} = useAccount();
  const queryClient = useQueryClient();

  const [amount, setAmount] = useState('');

  const {data, isLoading} = useQuery({
    queryKey: ['presale', address],
    queryFn: () => api.presale(address),
    refetchInterval: 15_000,
  });

  const {data: position} = useQuery({
    queryKey: ['position', address, wallet],
    queryFn: () => api.position(address, wallet!),
    enabled: Boolean(wallet),
    refetchInterval: 15_000,
  });

  // Null means the sale is open rather than gated, which is a normal state, not an error.
  const {data: tier} = useQuery({
    queryKey: ['tier', address, wallet],
    queryFn: () => api.tierProof(address, wallet!),
    enabled: Boolean(wallet),
  });

  const {writeContract, data: hash, isPending, error, reset} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  const refresh = useCallback(() => {
    setAmount('');
    void queryClient.invalidateQueries({queryKey: ['presale', address]});
    void queryClient.invalidateQueries({queryKey: ['position', address, wallet]});
  }, [queryClient, address, wallet]);

  useEffect(() => {
    if (isSuccess) refresh();
  }, [isSuccess, refresh]);

  if (isLoading || !data) {
    return <div className="h-64 animate-pulse rounded-xl bg-neutral-900" />;
  }

  const {presale, locks} = data;
  const busy = isPending || confirming;
  const parsed = parseAmount(amount);

  const contributed = BigInt(position?.contributedUsd ?? '0');
  const allocation = BigInt(position?.tokenAllocation ?? '0');

  const isCreator = Boolean(wallet && wallet.toLowerCase() === presale.creator.toLowerCase());
  const canContribute = presale.status === 'LIVE';
  const canRefund = presale.status === 'FAILED' && contributed > 0n;
  const canClaim = presale.status === 'FINALISED' && allocation > 0n && !position?.hasClaimed;
  const canFinalise = isCreator && presale.status === 'SUCCEEDED';

  const activeLocks = locks.filter((lock) => !lock.withdrawn);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {presale.tokenName ?? shortAddress(presale.token)}
            </h1>
            <span
              className={cn(
                'rounded-full px-2.5 py-1 text-xs capitalize',
                STATUS_STYLES[presale.status],
              )}
            >
              {presale.status.toLowerCase()}
            </span>
            {presale.isVerified && (
              <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-300">
                reviewed
              </span>
            )}
          </div>

          <p className="text-sm text-neutral-500">
            {presale.tokenSymbol} · {shortAddress(presale.token)}
          </p>
        </header>

        {/* Progress against both caps. Showing the soft cap matters more than the hard cap: it is
            the line that decides whether contributors get tokens or their money back. */}
        <div className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-neutral-500">Raised</span>
            <span className="text-2xl font-semibold tabular-nums">
              {formatUsd(presale.raisedUsd)}{' '}
              <span className="text-base font-normal text-neutral-500">
                of {formatUsd(presale.hardCapUsd)}
              </span>
            </span>
          </div>

          <div className="relative h-3 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-500"
              style={{width: `${Math.min(100, presale.progressBps / 100)}%`}}
            />
            {/* Soft cap marker. */}
            <div
              className="absolute inset-y-0 w-0.5 bg-neutral-100"
              style={{
                left: `${Math.min(100, (Number(BigInt(presale.softCapUsd) / 10n ** 12n) / Number(BigInt(presale.hardCapUsd) / 10n ** 12n)) * 100)}%`,
              }}
              title="Soft cap"
            />
          </div>

          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span
              className={cn(
                presale.softCapReached ? 'text-emerald-400' : 'text-neutral-500',
              )}
            >
              Soft cap {formatUsd(presale.softCapUsd)}{' '}
              {presale.softCapReached ? 'reached' : 'not yet reached'}
            </span>
            <span className="text-neutral-500">{presale.contributorCount} contributors</span>
          </div>
        </div>

        {/* The single most important thing a buyer needs to know before sending money. */}
        {!presale.softCapReached && presale.status !== 'FINALISED' && (
          <div className="card border-neutral-700 bg-neutral-900/60">
            <p className="text-sm text-neutral-300">
              <strong className="text-white">If the soft cap is not reached</strong>, every
              contribution is refundable in full. Refunds need no action from the project and the
              project cannot prevent them: the only path from escrow to the creator is
              finalisation, and finalisation reverts below the soft cap.
            </p>
          </div>
        )}

        <div className="card">
          <h2 className="mb-3 text-sm font-medium">Sale terms</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-neutral-500">Rate</dt>
              <dd className="tabular-nums">
                {formatPrice(presale.tokensPerUsd)} {presale.tokenSymbol} per $1
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">Min buy</dt>
              <dd className="tabular-nums">{formatUsd(presale.minContributionUsd)}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Max buy</dt>
              <dd className="tabular-nums">
                {tier ? formatUsd(tier.allowanceUsd) : formatUsd(presale.maxContributionUsd)}
                {tier && <span className="ml-1 text-xs text-amber-400">your tier</span>}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">Opens</dt>
              <dd>{new Date(presale.startTime).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Closes</dt>
              <dd>{new Date(presale.endTime).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Access</dt>
              <dd>
                {presale.tierRoot === `0x${'0'.repeat(64)}` ? 'Open to all' : 'Allowlisted'}
              </dd>
            </div>
          </dl>
        </div>

        {/* Liquidity locks. The evidence behind a project's claims, rather than the claims. */}
        <div className="card">
          <h2 className="mb-3 text-sm font-medium">Liquidity locks</h2>

          {activeLocks.length === 0 ? (
            <p className="text-sm text-amber-300">
              No liquidity is locked for this token. That does not mean the project is dishonest,
              but nothing here prevents liquidity from being withdrawn.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-800 text-sm">
              {activeLocks.map((lock) => (
                <li key={lock.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p>{lock.description || 'Locked liquidity'}</p>
                    <p className="text-xs text-neutral-600">
                      {formatPrice(lock.amount)} {lock.tokenSymbol ?? ''}
                    </p>
                  </div>
                  <span className="text-right text-sm">
                    <span className="text-neutral-400">unlocks in </span>
                    <span className="tabular-nums">
                      {formatCountdown(lock.unlockAt) ?? 'unlocked'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {presale.contributions.length > 0 && (
          <div className="card">
            <h2 className="mb-3 text-sm font-medium">Recent contributions</h2>
            <ul className="divide-y divide-neutral-800 text-sm">
              {presale.contributions.slice(0, 10).map((contribution) => (
                <li key={contribution.id} className="flex justify-between py-2">
                  <span className="text-neutral-400">
                    {shortAddress(contribution.contributor)}
                  </span>
                  <span className="text-right">
                    <span className="tabular-nums">{formatUsd(contribution.usdValue)}</span>
                    <span className="ml-2 text-xs text-neutral-600">
                      {formatRelativeTime(contribution.blockTime)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Action panel */}
      <div className="space-y-4">
        <div className="card space-y-4">
          {presale.status === 'LIVE' && (
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-neutral-500">Closes in</span>
              <span className="tabular-nums">{formatCountdown(presale.endTime) ?? 'now'}</span>
            </div>
          )}
          {presale.status === 'PENDING' && (
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-neutral-500">Opens in</span>
              <span className="tabular-nums">{formatCountdown(presale.startTime) ?? 'now'}</span>
            </div>
          )}

          {wallet && contributed > 0n && (
            <dl className="grid grid-cols-2 gap-3 border-t border-neutral-800 pt-4 text-sm">
              <div>
                <dt className="text-neutral-500">You contributed</dt>
                <dd className="tabular-nums">{formatUsd(position?.contributedUsd)}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">Your allocation</dt>
                <dd className="tabular-nums">
                  {formatPrice(allocation)} {presale.tokenSymbol}
                </dd>
              </div>
            </dl>
          )}

          {canContribute && (
            <>
              <div>
                <label className="label" htmlFor="amount">
                  Contribute (BNB)
                </label>
                <input
                  id="amount"
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
                disabled={!wallet || !parsed || parsed === 0n || busy}
                onClick={() => {
                  if (!parsed) return;
                  reset();

                  writeContract({
                    address: address as `0x${string}`,
                    abi: presaleAbi,
                    functionName: 'contribute',
                    // A gated sale needs the tier allowance and proof; an open one must send an
                    // empty proof, which the contract rejects if non-empty.
                    args: [tier ? BigInt(tier.allowanceUsd) : 0n, tier?.proof ?? []],
                    value: parsed,
                  });
                }}
              >
                {!wallet ? 'Connect wallet' : busy ? 'Contributing…' : 'Contribute'}
              </button>

              {tier && (
                <p className="text-xs text-amber-400">
                  You are on the allowlist with a {formatUsd(tier.allowanceUsd)} allocation.
                </p>
              )}
            </>
          )}

          {canRefund && (
            <>
              <p className="text-sm text-neutral-400">
                This sale did not reach its soft cap. Your contribution is refundable in full.
              </p>
              <button
                type="button"
                className="btn-primary w-full"
                disabled={busy}
                onClick={() => {
                  reset();
                  writeContract({
                    address: address as `0x${string}`,
                    abi: presaleAbi,
                    functionName: 'refund',
                  });
                }}
              >
                {busy ? 'Refunding…' : `Refund ${formatUsd(position?.contributedUsd)}`}
              </button>
            </>
          )}

          {canClaim && (
            <button
              type="button"
              className="btn-primary w-full"
              disabled={busy}
              onClick={() => {
                reset();
                writeContract({
                  address: address as `0x${string}`,
                  abi: presaleAbi,
                  functionName: 'claim',
                });
              }}
            >
              {busy
                ? 'Claiming…'
                : `Claim ${formatPrice(allocation)} ${presale.tokenSymbol}`}
            </button>
          )}

          {position?.hasClaimed && (
            <p className="text-sm text-emerald-400">You have claimed your tokens.</p>
          )}

          {canFinalise && (
            <>
              <p className="text-sm text-neutral-400">
                The soft cap was met. Finalising delivers the proceeds and opens claims. It requires
                the sale to hold enough tokens to honour every claim first.
              </p>
              <button
                type="button"
                className="btn-primary w-full"
                disabled={busy}
                onClick={() => {
                  reset();
                  writeContract({
                    address: address as `0x${string}`,
                    abi: presaleAbi,
                    functionName: 'finalize',
                  });
                }}
              >
                {busy ? 'Finalising…' : 'Finalise sale'}
              </button>
            </>
          )}

          {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}
        </div>

        <div className="card">
          <h2 className="mb-2 text-sm font-medium">Before you contribute</h2>
          <ul className="space-y-2 text-xs text-neutral-500">
            <li>
              A &quot;reviewed&quot; badge is a curation signal from the launchpad, not a safety
              guarantee. It does not mean the project has been audited.
            </li>
            <li>
              Check the liquidity locks above. Locked liquidity cannot be withdrawn early by anyone,
              including the launchpad.
            </li>
            <li>
              Sale terms are fixed at creation. Caps, price and timing cannot be changed after
              contributions begin.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
