'use client';

import {useQuery} from '@tanstack/react-query';
import {useState} from 'react';
import {api} from '@/lib/api';
import {cn} from '@/lib/cn';
import {formatCountdown, formatPrice, shortAddress} from '@/lib/format';

/**
 * Lock explorer.
 *
 * Deliberately a lookup by token rather than a curated list. The point of a locker is that anyone
 * can verify a project's claims independently, which means the interesting flow is "paste the
 * token address a project gave you and see what is actually locked".
 */
export default function LocksPage() {
  const [input, setInput] = useState('');
  const [token, setToken] = useState('');

  const {data, isLoading, isError} = useQuery({
    queryKey: ['locks', token],
    queryFn: () => api.locks(token),
    enabled: /^0x[0-9a-fA-F]{40}$/.test(token),
    retry: false,
  });

  const now = Date.now();

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Liquidity locks</h1>
        <p className="max-w-2xl text-neutral-400">
          Locks here cannot be withdrawn early by anyone. There is no owner, no admin role and no
          emergency function on the locker contract, because an escape hatch is exactly what gets
          used during a rug.
        </p>
      </header>

      <form
        className="flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setToken(input.trim());
        }}
      >
        <input
          className="input flex-1 font-mono text-sm"
          placeholder="Token address (0x…)"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit" className="btn-primary">
          Look up
        </button>
      </form>

      {token && !/^0x[0-9a-fA-F]{40}$/.test(token) && (
        <p className="text-sm text-red-400">That does not look like an address.</p>
      )}

      {isLoading && token && <div className="h-40 animate-pulse rounded-xl bg-neutral-900" />}

      {isError && <p className="text-sm text-red-400">Could not load locks for that token.</p>}

      {data && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card">
              <p className="text-xs uppercase tracking-wide text-neutral-500">Currently locked</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatPrice(data.totalLocked)}
              </p>
            </div>
            <div className="card">
              <p className="text-xs uppercase tracking-wide text-neutral-500">Active locks</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{data.activeLocks}</p>
            </div>
          </div>

          {data.locks.length === 0 ? (
            <div className="card border-amber-900/60 bg-amber-950/20">
              <p className="text-sm text-amber-200">
                Nothing is locked for this token. That is not proof of bad intent, but nothing here
                prevents liquidity from being removed.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-neutral-800">
              <table className="w-full text-sm">
                <thead className="bg-neutral-900/50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Owner</th>
                    <th className="px-4 py-3">Unlocks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800">
                  {data.locks.map((lock) => {
                    const unlocked = new Date(lock.unlockAt).getTime() <= now;

                    return (
                      <tr key={lock.id} className="hover:bg-neutral-900/40">
                        <td className="px-4 py-3">
                          {lock.description || 'Locked liquidity'}
                          {lock.withdrawn && (
                            <span className="ml-2 text-xs text-neutral-600">withdrawn</span>
                          )}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {formatPrice(lock.amount)} {lock.tokenSymbol ?? ''}
                        </td>
                        <td className="px-4 py-3 text-neutral-400">{shortAddress(lock.owner)}</td>
                        <td
                          className={cn(
                            'px-4 py-3 tabular-nums',
                            lock.withdrawn
                              ? 'text-neutral-600'
                              : unlocked
                                ? 'text-amber-400'
                                : 'text-emerald-400',
                          )}
                        >
                          {lock.withdrawn
                            ? '—'
                            : (formatCountdown(lock.unlockAt) ?? 'unlocked')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
