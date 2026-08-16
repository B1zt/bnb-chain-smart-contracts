'use client';

import {useQuery} from '@tanstack/react-query';
import Link from 'next/link';
import {api, formatBps, formatUsd} from '@/lib/api';
import {formatPrice} from '@/lib/format';

function Stat({label, value, hint}: {label: string; value: string; hint?: string}) {
  return (
    <div className="card">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-neutral-600">{hint}</p>}
    </div>
  );
}

export default function HomePage() {
  const {data: pools} = useQuery({queryKey: ['pools'], queryFn: () => api.pools({sort: 'apr'})});
  const {data: vault} = useQuery({
    queryKey: ['vault'],
    queryFn: api.vault,
    // A vault is optional in this deployment, so a 404 is a normal state, not an error to retry.
    retry: false,
  });

  const best = pools?.pools[0];

  return (
    <div className="space-y-12">
      <section className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">Yield farming on BNB Chain</h1>
        <p className="max-w-2xl text-neutral-400">
          A MasterChef farm with per-second emissions and an ERC-4626 vault that auto-compounds
          through PancakeSwap. TVL and APR are priced from Chainlink feeds that refuse to serve a
          stale answer.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total value locked" value={formatUsd(pools?.totalTvlUsd ?? null)} />
        <Stat
          label="Best APR"
          value={best ? formatBps(best.aprBps) : '-'}
          hint={best?.name ?? undefined}
        />
        <Stat label="Pools" value={pools ? String(pools.pools.length) : '-'} />
        <Stat
          label="Vault share price"
          value={vault ? formatPrice(vault.pricePerShare) : '-'}
          hint={vault ? 'Rises with every compound' : 'No vault deployed'}
        />
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {[
          {
            href: '/farms',
            title: 'Farm LP tokens',
            body: 'Per-second emissions weighted by allocation points, with deposit fees and harvest lockups configurable per pool. Emergency withdraw always works, even if the reward token does not.',
          },
          {
            href: '/vault',
            title: 'Auto-compound',
            body: 'Deposit LP once and the vault harvests, swaps and re-adds liquidity for you. Anyone can trigger a compound and earn a bounty, so it never depends on one keeper staying alive.',
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
