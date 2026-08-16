import type {Metadata} from 'next';
import Link from 'next/link';
import {Header} from '@/components/Header';
import {Providers} from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'B1zt Launchpad',
  description:
    'Token launchpad on BNB Chain: presales with unconditional refunds, verifiable liquidity locks, and a threshold-validated cross-chain bridge.',
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
              Reference implementation, not audited.{' '}
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
