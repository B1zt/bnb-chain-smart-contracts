'use client';

import {ConnectButton} from '@rainbow-me/rainbowkit';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {cn} from '@/lib/cn';

const links = [
  {href: '/farms', label: 'Farms'},
  {href: '/vault', label: 'Auto-Compound'},
  {href: '/portfolio', label: 'Portfolio'},
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            B1zt<span className="text-amber-400">.farm</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'rounded-md px-3 py-2 text-sm transition-colors',
                  pathname.startsWith(link.href)
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100',
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <ConnectButton showBalance={false} chainStatus="icon" />
      </div>
    </header>
  );
}
