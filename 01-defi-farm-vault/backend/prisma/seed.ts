/**
 * Demo data.
 *
 * The indexer fills these tables from chain events, so a fresh database renders every page as an
 * empty state. This writes a plausible slice of farm activity so the UI can be clicked through
 * immediately, and so the README screenshots show the app working.
 *
 * Pool ids, LP addresses and the vault figures line up with what `contracts/script/Demo.s.sol`
 * deploys, so the indexed rows and the live contract reads agree.
 *
 * Safe to re-run: every table it touches is cleared first. Local databases only.
 *
 *   pnpm db:seed
 */
import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

/** Anvil's default accounts. Public mnemonic, worthless anywhere real. */
const WALLETS = {
  deployer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  alice: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  bob: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  carol: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
} as const;

/** Deployed by contracts/script/Demo.s.sol on a fresh Anvil. */
const LP_TOKEN = (process.env.LP_TOKEN ?? '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0').toLowerCase();
const LP_TOKEN_2 = (process.env.LP_TOKEN_2 ?? '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9').toLowerCase();
const WBNB = (process.env.WRAPPED_NATIVE ?? '0x5fbdb2315678afecb367f032d93f642f64180aa3').toLowerCase();
const BUSD = (process.env.BUSD ?? '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512').toLowerCase();

const ONE = 10n ** 18n;

/**
 * USD amounts are stored with 18 decimals, the same as token amounts, so integer maths in the APR
 * calculation never has to change scale. Writing a bare "6396000" here would render as $0.00.
 */
function usd(dollars: number): string {
  return (BigInt(dollars) * ONE).toString();
}

function usdCents(cents: number): string {
  return ((BigInt(cents) * ONE) / 100n).toString();
}

function fakeHash(prefix: string, index: number): string {
  const body = `${prefix}${index}`
    .split('')
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return `0x${body.padEnd(64, '0').slice(0, 64)}`;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

async function main(): Promise<void> {
  console.log('clearing existing demo data');

  await prisma.farmEvent.deleteMany();
  await prisma.poolSnapshot.deleteMany();
  await prisma.position.deleteMany();
  await prisma.pool.deleteMany();
  await prisma.vaultPosition.deleteMany();
  await prisma.vaultSnapshot.deleteMany();
  await prisma.compoundRun.deleteMany();

  /* ------------------------------------------------------------------ pools --- */

  const pools = [
    {
      id: 0,
      lpToken: LP_TOKEN,
      name: 'WBNB-BUSD',
      token0: WBNB,
      token1: BUSD,
      token0Symbol: 'WBNB',
      token1Symbol: 'BUSD',
      allocPoint: '4000',
      depositFeeBps: 0,
      harvestLockup: 0,
      lpSupply: 5_330n,
      tvlUsd: usd(6_396_000),
      aprBps: 8_420,
    },
    {
      id: 1,
      lpToken: LP_TOKEN_2,
      name: 'BUSD-WBNB',
      token0: BUSD,
      token1: WBNB,
      token0Symbol: 'BUSD',
      token1Symbol: 'WBNB',
      allocPoint: '1000',
      // A deposit fee and a harvest lockup, so the pool list shows two genuinely different configs
      // rather than the same row twice.
      depositFeeBps: 200,
      harvestLockup: 12 * 3_600,
      lpSupply: 1_180n,
      tvlUsd: usd(1_416_000),
      aprBps: 2_105,
    },
  ];

  console.log(`seeding ${pools.length} pools`);

  for (const pool of pools) {
    await prisma.pool.create({
      data: {...pool, lpSupply: (pool.lpSupply * ONE).toString(), isActive: true},
    });
  }

  /* -------------------------------------------------------------- positions --- */

  const positions = [
    {poolId: 0, address: WALLETS.deployer, amount: 1_800n, harvested: 412n},
    {poolId: 0, address: WALLETS.alice, amount: 1_400n, harvested: 305n},
    {poolId: 0, address: WALLETS.bob, amount: 820n, harvested: 178n},
    {poolId: 0, address: WALLETS.carol, amount: 310n, harvested: 24n},
  ];

  console.log(`seeding ${positions.length} farm positions`);

  for (const position of positions) {
    await prisma.position.create({
      data: {
        poolId: position.poolId,
        address: position.address,
        amount: (position.amount * ONE).toString(),
        totalHarvested: (position.harvested * ONE).toString(),
      },
    });
  }

  /* ----------------------------------------------------------------- events --- */

  const kinds = ['deposit', 'harvest', 'withdraw', 'deposit', 'harvest', 'deposit'];
  const actors = [WALLETS.alice, WALLETS.bob, WALLETS.carol, WALLETS.deployer];

  console.log('seeding farm activity');

  await prisma.farmEvent.createMany({
    data: Array.from({length: 18}, (_unused, index) => ({
      poolId: index % 2,
      address: actors[index % actors.length]!,
      kind: kinds[index % kinds.length]!,
      amount: (BigInt(40 + index * 17) * ONE).toString(),
      fee: index % 2 === 1 ? (((BigInt(index) * ONE) / 100n).toString()) : '0',
      txHash: fakeHash('farm', index),
      logIndex: 0,
      blockNumber: BigInt(1_000 + index * 7),
      blockTime: hoursAgo(72 - index * 4),
    })),
  });

  // A fortnight of daily snapshots per pool, so the APR chart has a shape.
  console.log('seeding pool snapshots');

  for (const pool of pools) {
    await prisma.poolSnapshot.createMany({
      data: Array.from({length: 14}, (_unused, day) => ({
        poolId: pool.id,
        lpSupply: (pool.lpSupply * ONE).toString(),
        tvlUsd: pool.tvlUsd,
        // APR wanders rather than trending cleanly, because a line that only goes one way reads as
        // made up.
        aprBps: pool.aprBps + Math.round(Math.sin(day) * 900),
        rewardPriceUsd: usdCents(42),
        capturedAt: hoursAgo((13 - day) * 24),
      })),
    });
  }

  /* ------------------------------------------------------------------ vault --- */

  console.log('seeding vault positions and compound history');

  // Shares carry the vault's `_decimalsOffset` of 6, so the first deposit mints 1e6 shares per
  // asset. These mirror exactly what contracts/script/Demo.s.sol deposits, so the indexed cost
  // basis and the live share balance describe the same position rather than two unrelated numbers.
  const SHARES_PER_ASSET = 10n ** 6n;

  await prisma.vaultPosition.createMany({
    data: [
      {
        address: WALLETS.deployer,
        shares: (800n * ONE * SHARES_PER_ASSET).toString(),
        netDeposited: (800n * ONE).toString(),
      },
      {
        address: WALLETS.alice,
        shares: (700n * ONE * SHARES_PER_ASSET).toString(),
        netDeposited: (700n * ONE).toString(),
      },
    ],
  });

  await prisma.vaultSnapshot.createMany({
    data: Array.from({length: 14}, (_unused, day) => {
      const drift = 10_000n + BigInt(day * 41);

      return {
        blockNumber: BigInt(2_000 + day),
        totalAssets: ((1_500n * ONE * drift) / 10_000n).toString(),
        totalShares: (1_500n * ONE * 10n ** 6n).toString(),
        pricePerShare: (drift * 10n ** 14n).toString(),
        capturedAt: hoursAgo((13 - day) * 24),
      };
    }),
  });

  // The keeper records every decision, not just the ones it acted on. Showing the skips is the
  // point: a compound that costs more gas than it earns should not happen, and the log is how you
  // prove the keeper knew that.
  const runs = [
    {outcome: 'compounded', pending: 82n, bounty: 4n, gas: '2100000000000000', lp: '31'},
    {outcome: 'skipped_unprofitable', pending: 6n, bounty: 0n, gas: '2200000000000000', lp: null},
    {outcome: 'compounded', pending: 119n, bounty: 5n, gas: '2050000000000000', lp: '44'},
    {outcome: 'skipped_unprofitable', pending: 11n, bounty: 0n, gas: '2400000000000000', lp: null},
    {outcome: 'compounded', pending: 95n, bounty: 4n, gas: '1980000000000000', lp: '36'},
    {outcome: 'skipped_unprofitable', pending: 3n, bounty: 0n, gas: '2300000000000000', lp: null},
  ];

  for (const [index, run] of runs.entries()) {
    await prisma.compoundRun.create({
      data: {
        txHash: run.lp ? fakeHash('compound', index) : null,
        outcome: run.outcome,
        pendingReward: (run.pending * ONE).toString(),
        expectedBounty: (run.bounty * ONE).toString(),
        estimatedGasWei: run.gas,
        bountyUsd: (Number(run.bounty) * 0.42).toFixed(2),
        gasCostUsd: (Number(run.gas) / 1e18 * 600).toFixed(4),
        lpAdded: run.lp ? (BigInt(run.lp) * ONE).toString() : null,
        createdAt: hoursAgo(36 - index * 6),
      },
    });
  }

  console.log('\ndone.');
  console.log(`  ${pools.length} pools, ${positions.length} positions, ${runs.length} keeper runs`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
