'use client';

import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useState} from 'react';
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from 'wagmi';
import {api, TRANSFER_STAGE, type BridgeTransfer} from '@/lib/api';
import {cn} from '@/lib/cn';
import {bridgeAbi, contracts, erc20Abi} from '@/lib/contracts';
import {formatCountdown, formatPrice, formatRelativeTime, parseAmount, shortAddress} from '@/lib/format';

/** Ordered stages, so progress can be rendered as a track rather than a label. */
const STAGES: BridgeTransfer['status'][] = [
  'OBSERVED',
  'CONFIRMED',
  'SIGNED',
  'SUBMITTED',
  'COMPLETED',
];

function TransferProgress({transfer}: {transfer: BridgeTransfer}) {
  const failed = transfer.status === 'FAILED';
  const delayed = transfer.status === 'DELAYED';
  const currentIndex = STAGES.indexOf(transfer.status);

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {STAGES.map((stage, index) => (
          <div
            key={stage}
            className={cn(
              'h-1 flex-1 rounded-full',
              failed
                ? 'bg-red-500/40'
                : index <= currentIndex
                  ? 'bg-emerald-500'
                  : 'bg-neutral-800',
            )}
          />
        ))}
      </div>

      <p className={cn('text-xs', failed ? 'text-red-400' : 'text-neutral-500')}>
        {TRANSFER_STAGE[transfer.status]}
        {transfer.status === 'OBSERVED' && transfer.requiredConfirmations && (
          <span className="tabular-nums">
            {' '}
            ({transfer.confirmations}/{transfer.requiredConfirmations})
          </span>
        )}
        {transfer.status === 'CONFIRMED' && (
          <span className="tabular-nums">
            {' '}
            ({transfer.signatureCount}/{transfer.requiredSignatures})
          </span>
        )}
        {delayed && transfer.executableAt && (
          <span> · executable in {formatCountdown(transfer.executableAt) ?? 'moments'}</span>
        )}
      </p>

      {failed && transfer.lastError && (
        <p className="text-xs text-red-400/70">{transfer.lastError}</p>
      )}
    </div>
  );
}

export default function BridgePage() {
  const {address} = useAccount();
  const queryClient = useQueryClient();

  const [tokenAddress, setTokenAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');

  const {data: config} = useQuery({queryKey: ['config'], queryFn: api.config});
  const {data: status} = useQuery({
    queryKey: ['bridgeStatus'],
    queryFn: api.bridgeStatus,
    refetchInterval: 30_000,
  });

  const {data: transfers} = useQuery({
    queryKey: ['transfers', address],
    queryFn: () => api.transfers({address: address!}),
    enabled: Boolean(address),
    // Transfers move through stages on their own, driven by the relayer, so the view has to poll.
    refetchInterval: 10_000,
  });

  const token = /^0x[0-9a-fA-F]{40}$/.test(tokenAddress)
    ? (tokenAddress as `0x${string}`)
    : undefined;

  const {data: symbol} = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'symbol',
    query: {enabled: Boolean(token)},
  });

  const {data: balance, refetch: refetchBalance} = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {enabled: Boolean(token && address)},
  });

  const {data: allowance, refetch: refetchAllowance} = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contracts.bridge] : undefined,
    query: {enabled: Boolean(token && address)},
  });

  const {data: dailyRemaining} = useReadContract({
    address: contracts.bridge,
    abi: bridgeAbi,
    functionName: 'remainingDailyLimit',
    args: token ? [token] : undefined,
    query: {enabled: Boolean(token)},
  });

  const {writeContract, data: hash, isPending, error, reset} = useWriteContract();
  const {isLoading: confirming, isSuccess} = useWaitForTransactionReceipt({hash});

  const refresh = useCallback(() => {
    setAmount('');
    void refetchBalance();
    void refetchAllowance();
    void queryClient.invalidateQueries({queryKey: ['transfers', address]});
  }, [queryClient, address, refetchBalance, refetchAllowance]);

  useEffect(() => {
    if (isSuccess) refresh();
  }, [isSuccess, refresh]);

  const parsed = parseAmount(amount);
  const busy = isPending || confirming;
  const needsApproval = parsed !== null && (allowance ?? 0n) < parsed;
  const destination = recipient || address || '';
  const overDailyLimit = parsed !== null && dailyRemaining !== undefined && parsed > dailyRemaining;

  if (status && !status.enabled) {
    return (
      <p className="py-24 text-center text-neutral-500">
        The bridge is not configured for this deployment.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Bridge</h1>
        <p className="max-w-2xl text-neutral-400">
          Tokens are locked on the source chain and released on the destination once a threshold of
          independent validators has signed. The relayer that carries the message cannot alter it:
          every field is covered by those signatures.
        </p>
      </header>

      {/* Honest, prominent risk framing. Bridges are the most exploited contract category there is,
          and a UI that hides that is doing its users a disservice. */}
      <div className="card border-amber-900/60 bg-amber-950/20">
        <h2 className="font-medium text-amber-200">Understand the trust model</h2>
        <p className="mt-2 text-sm text-amber-100/70">
          This is an externally-validated bridge. Its security rests on the assumption that a
          majority of validators are honest and independently operated. That assumption has failed
          before, on bridges far larger than this one. This implementation has not been audited and
          is published as a reference.
        </p>
        {status?.enabled && (
          <p className="mt-2 text-xs text-amber-100/50">
            Currently {status.onChainThreshold} of {status.validatorCount} signatures required
            {status.paused ? ' · bridge is paused' : ''}
            {status.thresholdMatchesConfig === false
              ? ' · relayer threshold does not match the contract'
              : ''}
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="card space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-500">From</span>
            <span>Chain {config?.bridge.sourceChainId ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-500">To</span>
            <span>Chain {config?.bridge.destinationChainId ?? '—'}</span>
          </div>

          <div className="border-t border-neutral-800 pt-4">
            <label className="label" htmlFor="token">
              Token address
            </label>
            <input
              id="token"
              className="input font-mono text-xs"
              placeholder="0x…"
              value={tokenAddress}
              onChange={(event) => setTokenAddress(event.target.value)}
            />
            {symbol && <p className="mt-1 text-xs text-neutral-500">{symbol}</p>}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="label mb-0">Amount</span>
              {balance !== undefined && (
                <button
                  type="button"
                  className="text-xs text-amber-400 hover:text-amber-300"
                  onClick={() => setAmount(formatPrice(balance))}
                >
                  Max {formatPrice(balance)}
                </button>
              )}
            </div>
            <input
              className="input tabular-nums"
              placeholder="0.00"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            {dailyRemaining !== undefined && (
              <p className="mt-1 text-xs text-neutral-500">
                {formatPrice(dailyRemaining)} remaining in today&apos;s bridge limit
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="recipient">
              Recipient on the destination chain
            </label>
            <input
              id="recipient"
              className="input font-mono text-xs"
              placeholder={address ?? '0x…'}
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
            />
            <p className="mt-1 text-xs text-neutral-500">
              Leave blank to use your own address.
            </p>
          </div>

          <button
            type="button"
            className="btn-primary w-full"
            disabled={
              !address ||
              !token ||
              !parsed ||
              parsed === 0n ||
              overDailyLimit ||
              busy ||
              Boolean(status?.paused)
            }
            onClick={() => {
              if (!token || !parsed || !config) return;
              reset();

              if (needsApproval) {
                writeContract({
                  address: token,
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [contracts.bridge, parsed],
                });
                return;
              }

              writeContract({
                address: contracts.bridge,
                abi: bridgeAbi,
                functionName: 'bridgeOut',
                args: [
                  token,
                  BigInt(config.bridge.destinationChainId),
                  destination as `0x${string}`,
                  parsed,
                ],
              });
            }}
          >
            {!address
              ? 'Connect wallet'
              : status?.paused
                ? 'Bridge paused'
                : overDailyLimit
                  ? 'Above daily limit'
                  : busy
                    ? 'Working…'
                    : needsApproval
                      ? `Approve ${symbol ?? 'token'}`
                      : 'Bridge'}
          </button>

          {error && <p className="text-sm text-red-400">{error.message.split('\n')[0]}</p>}

          <p className="text-xs text-neutral-600">
            Transfers above the large-transfer threshold are held for an hour before release. That
            delay exists so a human can pause the bridge if something looks wrong.
          </p>
        </div>

        <div className="space-y-4">
          <h2 className="font-medium">Your transfers</h2>

          {!address ? (
            <p className="py-12 text-center text-sm text-neutral-500">Connect a wallet.</p>
          ) : (transfers?.transfers.length ?? 0) === 0 ? (
            <p className="py-12 text-center text-sm text-neutral-600">No transfers yet.</p>
          ) : (
            <ul className="space-y-3">
              {transfers!.transfers.map((transfer) => (
                <li key={transfer.messageHash} className="card space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="tabular-nums">{formatPrice(transfer.amount)}</p>
                      <p className="text-xs text-neutral-600">
                        to {shortAddress(transfer.recipient)} on chain{' '}
                        {transfer.destinationChainId}
                      </p>
                    </div>
                    <span className="text-xs text-neutral-600">
                      {formatRelativeTime(transfer.createdAt)}
                    </span>
                  </div>

                  <TransferProgress transfer={transfer} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
