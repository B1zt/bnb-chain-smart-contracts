'use client';

import '@rainbow-me/rainbowkit/styles.css';
import {RainbowKitProvider, darkTheme} from '@rainbow-me/rainbowkit';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useState, type ReactNode} from 'react';
import {WagmiProvider} from 'wagmi';
import {wagmiConfig} from '@/lib/wagmi';

export function Providers({children}: {children: ReactNode}) {
  // Created inside a state initialiser rather than at module scope. A module-level client would be
  // shared across every request during SSR, leaking one user's cached data into another's render.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            // Chain state moves on its own, so refetching when the user returns to the tab is
            // usually right. Retrying is not: a reverted call fails the same way every time.
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({accentColor: '#f59e0b', borderRadius: 'medium'})}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
