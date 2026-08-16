'use client';

import {useQuery} from '@tanstack/react-query';
import Link from 'next/link';
import {api, formatUsd} from '@/lib/api';

export default function HomePage() {
  const {data: live} = useQuery({
    queryKey: ['presales', 'LIVE'],
    queryFn: () => api.presales({status: 'LIVE'}),
  });

  const {data: bridge} = useQuery({queryKey: ['bridgeStatus'], queryFn: api.bridgeStatus});

  const totalRaised = (live?.presales ?? []).reduce(
    (sum, presale) => sum + BigInt(presale.raisedUsd),
    0n,
  );

  return (
    <div className="space-y-12">
      <section className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">Launch on BNB Chain</h1>
        <p className="max-w-2xl text-neutral-400">
          Presales with unconditional refunds, liquidity locks anyone can verify, and a cross-chain
          bridge with a threshold validator set. Everything here is designed so a buyer can check
          the guarantees rather than trust them.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Live sales</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{live?.presales.length ?? '-'}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Raised, live sales</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatUsd(totalRaised.toString())}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Bridge</p>
          <p className="mt-1 text-2xl font-semibold">
            {!bridge?.enabled ? 'Off' : bridge.paused ? 'Paused' : 'Live'}
          </p>
          {bridge?.enabled && bridge.validatorCount && (
            <p className="mt-1 text-xs text-neutral-600">
              {bridge.onChainThreshold} of {bridge.validatorCount} validators
            </p>
          )}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          {
            href: '/launchpad',
            title: 'Browse sales',
            body: 'Every presale refunds in full below its soft cap, without needing the project to act and without the project being able to stop it.',
          },
          {
            href: '/locks',
            title: 'Verify locks',
            body: 'Liquidity locks with no early withdrawal for anyone. No owner override, no emergency function, no admin who can shorten a lock.',
          },
          {
            href: '/bridge',
            title: 'Bridge tokens',
            body: 'A threshold of independent validators must sign each release, and large transfers wait out a delay that gives a human time to react.',
          },
        ].map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="card space-y-2 transition-colors hover:border-neutral-700"
          >
            <h2 className="font-medium">{card.title}</h2>
            <p className="text-sm text-neutral-400">{card.body}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
