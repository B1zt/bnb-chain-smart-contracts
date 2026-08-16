'use client';

import {useQuery} from '@tanstack/react-query';
import Link from 'next/link';
import {useState} from 'react';
import {api, formatUsd, type PresaleStatus} from '@/lib/api';
import {cn} from '@/lib/cn';
import {formatCountdown, shortAddress} from '@/lib/format';

const FILTERS: {label: string; status?: PresaleStatus}[] = [
  {label: 'All'},
  {label: 'Live', status: 'LIVE'},
  {label: 'Upcoming', status: 'PENDING'},
  {label: 'Ended', status: 'FINALISED'},
];

export default function LaunchpadPage() {
  const [filter, setFilter] = useState(0);
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  const {data, isLoading} = useQuery({
    queryKey: ['presales', filter, verifiedOnly],
    queryFn: () => api.presales({status: FILTERS[filter]!.status, verifiedOnly}),
    refetchInterval: 30_000,
  });

  const presales = data?.presales ?? [];

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Launchpad</h1>
        <p className="max-w-2xl text-neutral-400">
          Every sale here refunds in full if it misses its soft cap, and that refund needs no action
          from the project. Sale terms are fixed at creation and the creator cannot reach the
          escrowed funds before finalisation.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-neutral-900 p-1">
          {FILTERS.map((entry, index) => (
            <button
              key={entry.label}
              type="button"
              onClick={() => setFilter(index)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                filter === index ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input
            type="checkbox"
            checked={verifiedOnly}
            onChange={(event) => setVerifiedOnly(event.target.checked)}
            className="h-4 w-4 rounded border-neutral-700 bg-neutral-900"
          />
          Reviewed only
        </label>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({length: 4}, (_unused, index) => (
            <div key={index} className="h-44 animate-pulse rounded-xl bg-neutral-900" />
          ))}
        </div>
      ) : presales.length === 0 ? (
        <p className="py-16 text-center text-neutral-600">No sales match these filters.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {presales.map((presale) => (
            <Link
              key={presale.address}
              href={`/launchpad/${presale.address}`}
              className="card space-y-4 transition-colors hover:border-neutral-700"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">
                    {presale.tokenName ?? shortAddress(presale.token)}
                  </h2>
                  <p className="text-sm text-neutral-500">{presale.tokenSymbol}</p>
                </div>

                <div className="flex shrink-0 gap-1.5">
                  {presale.isVerified && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
                      reviewed
                    </span>
                  )}
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs capitalize',
                      presale.status === 'LIVE'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : presale.status === 'FAILED'
                          ? 'bg-red-500/15 text-red-300'
                          : 'bg-neutral-800 text-neutral-400',
                    )}
                  >
                    {presale.status.toLowerCase()}
                  </span>
                </div>
              </div>

              <div>
                <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-amber-500"
                    style={{width: `${Math.min(100, presale.progressBps / 100)}%`}}
                  />
                </div>
                <div className="mt-2 flex justify-between text-xs text-neutral-500">
                  <span>{formatUsd(presale.raisedUsd)} raised</span>
                  <span>{formatUsd(presale.hardCapUsd)} cap</span>
                </div>
              </div>

              <div className="flex justify-between text-sm">
                <span className={presale.softCapReached ? 'text-emerald-400' : 'text-neutral-500'}>
                  {presale.softCapReached ? 'Soft cap reached' : 'Soft cap pending'}
                </span>
                {presale.status === 'LIVE' && (
                  <span className="tabular-nums text-neutral-400">
                    {formatCountdown(presale.endTime) ?? 'ending'}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
