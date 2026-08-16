import {erc20Abi, oracleAbi, pairAbi} from './chain/abis.js';
import {publicClient} from './chain/client.js';
import {config} from './config.js';
import {logger} from './lib/logger.js';

const WAD = 10n ** 18n;

/** USD prices are carried at 18 decimals throughout, matching the on-chain oracle. */
export type UsdPrice = bigint;

/**
 * Price and TVL maths for the farm.
 *
 * **Why LP tokens cannot be priced naively.** The obvious approach is to read the pair's reserves,
 * value both sides, and divide by total supply. That is correct only when the pool is balanced at
 * the true market price, and it is trivially manipulable: flash-loan the pool out of balance, and
 * the computed LP price moves with it. Anything that spends money based on that number can be
 * drained.
 *
 * The safe version, used here, values LP off the *invariant* rather than the spot reserves:
 *
 *     fairPrice = 2 * sqrt(r0 * r1) * sqrt(p0 * p1) / totalSupply
 *
 * `sqrt(r0 * r1)` is constant under a swap, so manipulating reserves does not move it. Prices come
 * from an oracle rather than the pool, so the whole expression is manipulation-resistant.
 *
 * The APR figures here are display-only, so a manipulable price would be a cosmetic bug rather than
 * a drain. The fair-value method is still used, because a farm UI showing a nonsensical APR after
 * someone pokes a thin pool is a support burden nobody needs.
 */

/** Integer square root, Babylonian method. `Math.sqrt` cannot take a bigint without losing precision. */
export function sqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('sqrt of negative');
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;

  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }

  return x;
}

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

const tokenCache = new Map<string, TokenInfo>();

/** Symbol and decimals for a token, cached. Neither can change, so one read is enough. */
export async function getTokenInfo(address: `0x${string}`): Promise<TokenInfo> {
  const cached = tokenCache.get(address.toLowerCase());
  if (cached) return cached;

  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({address, abi: erc20Abi, functionName: 'symbol'}).catch(() => '???'),
    publicClient.readContract({address, abi: erc20Abi, functionName: 'decimals'}).catch(() => 18),
  ]);

  const info: TokenInfo = {address, symbol, decimals: Number(decimals)};
  tokenCache.set(address.toLowerCase(), info);

  return info;
}

/**
 * USD price of a token at 18 decimals, or null if unavailable.
 *
 * The oracle is tried first because it is manipulation-resistant. `REWARD_TOKEN_PRICE_USD` is a
 * configured fallback for a freshly launched reward token that no feed covers yet, which is the
 * normal situation for a new farm.
 */
export async function getTokenPriceUsd(address: `0x${string}`): Promise<UsdPrice | null> {
  if (config.ORACLE_ADDRESS) {
    try {
      const [ok, price] = await publicClient.readContract({
        address: config.ORACLE_ADDRESS,
        abi: oracleAbi,
        functionName: 'tryGetPrice',
        args: [address],
      });

      if (ok && price > 0n) return price;
    } catch (error) {
      logger.debug({error, token: address}, 'oracle read failed');
    }
  }

  if (
    address.toLowerCase() === config.REWARD_TOKEN_ADDRESS &&
    config.REWARD_TOKEN_PRICE_USD !== undefined
  ) {
    // Configured price, scaled to 18 decimals. Six decimal places is plenty for a display price.
    return BigInt(Math.round(config.REWARD_TOKEN_PRICE_USD * 1e6)) * 10n ** 12n;
  }

  return null;
}

export interface LpValuation {
  /** USD value of one whole LP token, at 18 decimals. */
  priceUsd: UsdPrice;
  token0: TokenInfo;
  token1: TokenInfo;
}

/**
 * Fair USD value of one LP token, using the invariant rather than spot reserves.
 *
 * Returns null when either side has no price, rather than guessing. A TVL figure built on a guessed
 * price is worse than no TVL figure.
 */
export async function getLpPriceUsd(lpToken: `0x${string}`): Promise<LpValuation | null> {
  try {
    const [token0Address, token1Address, reserves, totalSupply] = await Promise.all([
      publicClient.readContract({address: lpToken, abi: pairAbi, functionName: 'token0'}),
      publicClient.readContract({address: lpToken, abi: pairAbi, functionName: 'token1'}),
      publicClient.readContract({address: lpToken, abi: pairAbi, functionName: 'getReserves'}),
      publicClient.readContract({address: lpToken, abi: pairAbi, functionName: 'totalSupply'}),
    ]);

    if (totalSupply === 0n) return null;

    const [token0, token1] = await Promise.all([
      getTokenInfo(token0Address),
      getTokenInfo(token1Address),
    ]);

    const [price0, price1] = await Promise.all([
      getTokenPriceUsd(token0Address),
      getTokenPriceUsd(token1Address),
    ]);

    if (price0 === null || price1 === null) return null;

    // Normalise reserves to 18 decimals so the geometric mean is dimensionally consistent. A
    // USDC/WBNB pair mixes 6 and 18 decimals, and skipping this makes the result off by 1e12.
    const reserve0 = scaleTo18(reserves[0], token0.decimals);
    const reserve1 = scaleTo18(reserves[1], token1.decimals);

    // fairPrice = 2 * sqrt(r0 * r1) * sqrt(p0 * p1) / totalSupply
    //
    // Both square roots are taken on values already scaled to 18 decimals, so each result carries
    // 9 decimals of scale. Multiplying them recovers 18, which is the target precision.
    const rootK = sqrt(reserve0 * reserve1);
    const rootPrice = sqrt(price0 * price1);

    const priceUsd = (2n * rootK * rootPrice) / totalSupply;

    return {priceUsd, token0, token1};
  } catch (error) {
    logger.debug({error, lpToken}, 'LP valuation failed');
    return null;
  }
}

/** Scale a raw token amount to 18 decimals. */
export function scaleTo18(amount: bigint, decimals: number): bigint {
  if (decimals === 18) return amount;
  if (decimals < 18) return amount * 10n ** BigInt(18 - decimals);
  return amount / 10n ** BigInt(decimals - 18);
}

/** USD value of `amount` units of a token priced at `priceUsd`. */
export function valueUsd(amount: bigint, decimals: number, priceUsd: UsdPrice): bigint {
  return (scaleTo18(amount, decimals) * priceUsd) / WAD;
}

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

/**
 * Simple (non-compounding) APR in basis points.
 *
 * APR, not APY. A farm's headline number is usually APY with daily compounding assumed, which is a
 * projection built on the assumption that emissions, prices and TVL all stay put for a year. None of
 * them will. APR is the honest figure, and the frontend derives APY from it where it wants one, so
 * the assumption is visible rather than baked into the API.
 */
export function calculateAprBps(
  rewardPerSecond: bigint,
  rewardPriceUsd: UsdPrice,
  tvlUsd: bigint,
): number {
  if (tvlUsd === 0n || rewardPriceUsd === 0n) return 0;

  const rewardsPerYear = rewardPerSecond * SECONDS_PER_YEAR;
  const rewardsUsdPerYear = (rewardsPerYear * rewardPriceUsd) / WAD;

  const bps = (rewardsUsdPerYear * 10_000n) / tvlUsd;

  // An absurd APR usually means a near-empty pool rather than a real opportunity, and rendering
  // "4,000,000%" makes a UI look broken. Clamped at a still-obviously-high 100,000%.
  const clamped = bps > 10_000_000n ? 10_000_000n : bps;

  return Number(clamped);
}

/** Convert a simple APR to a compounding APY, given a compounding frequency. */
export function aprToApy(aprBps: number, compoundsPerYear = 365): number {
  const apr = aprBps / 10_000;
  return (Math.pow(1 + apr / compoundsPerYear, compoundsPerYear) - 1) * 10_000;
}
