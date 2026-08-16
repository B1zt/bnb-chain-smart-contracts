import type {Metadata} from 'next';
import Link from 'next/link';
import {Header} from '@/components/Header';
import {Providers} from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'B1zt BSC Farm',
  description:
    'Yield farm on BNB Smart Chain with per-second emissions, an auto-compounding ERC-4626 vault via PancakeSwap, and Chainlink-priced TVL.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
          <footer className="border-t border-neutral-800 py-8 text-center text-sm text-neutral-500">
            <p>
              Reference implementation.{' '}
              <Link
                href="https://github.com/B1zt/bnb-chain-smart-contracts"
                className="text-neutral-300 underline underline-offset-4 hover:text-white"
              >
                Source on GitHub
              </Link>
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
