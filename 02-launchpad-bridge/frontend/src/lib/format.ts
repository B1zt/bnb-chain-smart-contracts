import {formatEther, formatUnits} from 'viem';

/** `0x1234…abcd`, the standard truncation for wallet addresses. */
export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Format a wei value for display.
 *
 * Trailing zeros are trimmed so `1.500000000000000000` renders as `1.5`, and very small non-zero
 * amounts collapse to `<0.0001` rather than a wall of zeros that reads as free.
 */
export function formatPrice(wei: bigint | string, decimals = 18): string {
  const value = typeof wei === 'string' ? BigInt(wei) : wei;
  if (value === 0n) return '0';

  const formatted = decimals === 18 ? formatEther(value) : formatUnits(value, decimals);
  const asNumber = Number(formatted);

  if (asNumber > 0 && asNumber < 0.0001) return '<0.0001';

  return formatted.replace(/\.?0+$/, '');
}

export function formatPriceWithSymbol(wei: bigint | string, currency: string): string {
  const isNative = currency === '0x0000000000000000000000000000000000000000';
  return `${formatPrice(wei)} ${isNative ? 'ETH' : 'WETH'}`;
}

/** Compact volume figures: 1234 -> 1.2K. */
export function formatCompact(wei: bigint | string): string {
  const value = Number(formatEther(typeof wei === 'string' ? BigInt(wei) : wei));

  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value === 0) return '0';
  if (value < 0.01) return '<0.01';

  return value.toFixed(2);
}

/** `2d 4h`, `3h 12m`, `45s`. Returns null once the deadline has passed. */
export function formatCountdown(target: Date | string | number): string | null {
  const deadline = new Date(target).getTime();
  const remaining = deadline - Date.now();

  if (remaining <= 0) return null;

  const seconds = Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;

  return `${seconds}s`;
}

export function formatRelativeTime(timestamp: Date | string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(elapsed / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;

  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Parse a user-typed amount into wei.
 *
 * Returns null rather than throwing, so a half-typed value like "0." leaves the input in a neutral
 * state instead of flashing a validation error on every keystroke.
 */
export function parseAmount(input: string, decimals = 18): bigint | null {
  const trimmed = input.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed)) return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;

  const padded = fraction.padEnd(decimals, '0');

  try {
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  } catch {
    return null;
  }
}
