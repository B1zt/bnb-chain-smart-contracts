/**
 * Demo data.
 *
 * The indexer fills these tables from chain events, so a fresh database renders the launchpad, the
 * locker and the bridge as three empty pages. This writes a plausible slice of activity so the UI
 * can be clicked through immediately, and so the README screenshots show the app working.
 *
 * The presale addresses and lock amounts match what `contracts/script/Demo.s.sol` deploys, so the
 * indexed rows and the live contract reads describe the same sales.
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
  dave: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
} as const;

/** Validators five through nine, matching the set the demo script installs on the bridge. */
const VALIDATORS = [
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f',
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
];

/** Printed by contracts/script/Demo.s.sol on a fresh Anvil. */
const SALES = {
  live: (process.env.PRESALE_LIVE ?? '0xBA12646CC07ADBe43F8bD25D83FB628D29C8A762').toLowerCase(),
  upcoming: (process.env.PRESALE_UPCOMING ?? '0x7ab4C4804197531f7ed6A6bc0f0781f706ff7953').toLowerCase(),
  failed: (process.env.PRESALE_FAILED ?? '0xc8CB5439c767A63aca1c01862252B2F3495fDcFE').toLowerCase(),
};

const SALE_TOKEN = (process.env.SALE_TOKEN ?? '0x5FbDB2315678afecb367f032d93F642f64180aa3').toLowerCase();
const LP_TOKEN = (process.env.LP_TOKEN ?? '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0').toLowerCase();

const USD = 10n ** 18n;
const ONE = 10n ** 18n;

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

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function main(): Promise<void> {
  console.log('clearing existing demo data');

  await prisma.bridgeSignature.deleteMany();
  await prisma.bridgeTransfer.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.presaleTier.deleteMany();
  await prisma.presale.deleteMany();
  await prisma.lock.deleteMany();

  /* --------------------------------------------------------------- presales --- */

  const presales = [
    {
      address: SALES.live,
      status: 'LIVE' as const,
      tokensPerUsd: 2_500n,
      softCap: 40_000n,
      hardCap: 120_000n,
      minContribution: 50n,
      maxContribution: 5_000n,
      startTime: hoursAgo(48),
      endTime: daysFromNow(5),
      // 6 BNB and 4 BNB at 600 USD, matching what the demo script contributes on chain.
      raised: 6_000n,
      contributors: 2,
      tierRoot: `0x${'0'.repeat(64)}`,
      name: 'Demo Project',
    },
    {
      address: SALES.upcoming,
      status: 'PENDING' as const,
      tokensPerUsd: 4_000n,
      softCap: 25_000n,
      hardCap: 80_000n,
      minContribution: 100n,
      maxContribution: 2_500n,
      startTime: daysFromNow(3),
      endTime: daysFromNow(10),
      raised: 0n,
      contributors: 0,
      tierRoot: fakeHash('tierroot', 1),
      name: 'Demo Project',
    },
    {
      address: SALES.failed,
      status: 'FAILED' as const,
      tokensPerUsd: 1_000n,
      softCap: 90_000n,
      hardCap: 150_000n,
      minContribution: 50n,
      maxContribution: 10_000n,
      startTime: hoursAgo(21 * 24),
      endTime: hoursAgo(1),
      raised: 1_200n,
      contributors: 1,
      tierRoot: `0x${'0'.repeat(64)}`,
      name: 'Demo Project',
    },
  ];

  console.log(`seeding ${presales.length} presales`);

  for (const sale of presales) {
    await prisma.presale.create({
      data: {
        address: sale.address,
        creator: WALLETS.deployer,
        token: SALE_TOKEN,
        tokenSymbol: 'DEMO',
        tokenName: sale.name,
        tokenDecimals: 18,
        tokensPerUsd: (sale.tokensPerUsd * ONE).toString(),
        softCapUsd: (sale.softCap * USD).toString(),
        hardCapUsd: (sale.hardCap * USD).toString(),
        minContributionUsd: (sale.minContribution * USD).toString(),
        maxContributionUsd: (sale.maxContribution * USD).toString(),
        startTime: sale.startTime,
        endTime: sale.endTime,
        tierRoot: sale.tierRoot,
        raisedUsd: (sale.raised * USD).toString(),
        contributorCount: sale.contributors,
        status: sale.status,
        isVerified: sale.status !== 'PENDING',
      },
    });
  }

  // Contributions on the live sale, matching the on-chain ones.
  await prisma.contribution.createMany({
    data: [
      {
        presaleAddress: SALES.live,
        contributor: WALLETS.alice,
        currency: '0x0000000000000000000000000000000000000000',
        amount: (6n * ONE).toString(),
        usdValue: (3_600n * USD).toString(),
        txHash: fakeHash('contrib', 0),
        logIndex: 0,
        blockNumber: 40n,
        blockTime: hoursAgo(20),
      },
      {
        presaleAddress: SALES.live,
        contributor: WALLETS.bob,
        currency: '0x0000000000000000000000000000000000000000',
        amount: (4n * ONE).toString(),
        usdValue: (2_400n * USD).toString(),
        txHash: fakeHash('contrib', 1),
        logIndex: 0,
        blockNumber: 41n,
        blockTime: hoursAgo(14),
      },
      {
        presaleAddress: SALES.failed,
        contributor: WALLETS.alice,
        currency: '0x0000000000000000000000000000000000000000',
        amount: (2n * ONE).toString(),
        usdValue: (1_200n * USD).toString(),
        txHash: fakeHash('contrib', 2),
        logIndex: 0,
        blockNumber: 42n,
        blockTime: hoursAgo(30),
      },
    ],
  });

  // Tier allowances for the gated sale. The on-chain root commits to these without revealing them,
  // so this table is the only place a proof can be built from.
  await prisma.presaleTier.createMany({
    data: [
      {presaleAddress: SALES.upcoming, address: WALLETS.alice, allowanceUsd: (10_000n * USD).toString(), leafIndex: 0},
      {presaleAddress: SALES.upcoming, address: WALLETS.bob, allowanceUsd: (5_000n * USD).toString(), leafIndex: 1},
      {presaleAddress: SALES.upcoming, address: WALLETS.carol, allowanceUsd: (2_500n * USD).toString(), leafIndex: 2},
    ],
  });

  /* ------------------------------------------------------------------ locks --- */

  console.log('seeding 3 liquidity locks');

  const locks = [
    {id: '0', amount: 40_000n, days: 365, description: 'Launch liquidity, 12 months'},
    {id: '1', amount: 15_000n, days: 90, description: 'Market making, 3 months'},
    {id: '2', amount: 5_000n, days: 7, description: 'Short term, 1 week'},
  ];

  for (const lock of locks) {
    await prisma.lock.create({
      data: {
        id: lock.id,
        token: LP_TOKEN,
        tokenSymbol: 'DEMO-LP',
        owner: WALLETS.deployer,
        amount: (lock.amount * ONE).toString(),
        lockedAt: hoursAgo(2),
        unlockAt: daysFromNow(lock.days),
        withdrawn: false,
        description: lock.description,
      },
    });
  }

  /* ----------------------------------------------------------------- bridge --- */

  // One transfer in each state that matters. COMPLETED is the happy path, SIGNED is waiting on
  // submission, and DELAYED is a large transfer sitting out its timelock, which is the single most
  // important control in the whole design: it is the window in which a compromised validator set
  // can be noticed before the money leaves.
  const transfers = [
    {
      status: 'COMPLETED' as const,
      amount: 2_500n,
      recipient: WALLETS.alice,
      signatures: 3,
      hoursOld: 26,
      completed: true,
      executableIn: null,
    },
    {
      status: 'COMPLETED' as const,
      amount: 780n,
      recipient: WALLETS.bob,
      signatures: 3,
      hoursOld: 18,
      completed: true,
      executableIn: null,
    },
    {
      status: 'SIGNED' as const,
      amount: 1_400n,
      recipient: WALLETS.carol,
      signatures: 3,
      hoursOld: 1,
      completed: false,
      executableIn: null,
    },
    {
      status: 'DELAYED' as const,
      amount: 250_000n,
      recipient: WALLETS.dave,
      signatures: 4,
      hoursOld: 0.4,
      completed: false,
      executableIn: 0.6,
    },
    {
      status: 'OBSERVED' as const,
      amount: 95n,
      recipient: WALLETS.alice,
      signatures: 0,
      hoursOld: 0.1,
      completed: false,
      executableIn: null,
    },
  ];

  console.log(`seeding ${transfers.length} bridge transfers`);

  for (const [index, transfer] of transfers.entries()) {
    const messageHash = fakeHash('bridge', index);

    await prisma.bridgeTransfer.create({
      data: {
        messageHash,
        sourceChainId: 31337,
        destinationChainId: 11155111,
        destinationBridge: '0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6',
        token: SALE_TOKEN,
        sender: WALLETS.deployer,
        recipient: transfer.recipient,
        amount: (transfer.amount * ONE).toString(),
        nonce: String(index),
        status: transfer.status,
        sourceTxHash: fakeHash('bridgetx', index),
        sourceBlockNumber: BigInt(500 + index),
        sourceBlockTime: hoursAgo(transfer.hoursOld),
        confirmations: transfer.status === 'OBSERVED' ? 4 : 15,
        destinationTxHash: transfer.completed ? fakeHash('desttx', index) : null,
        completedAt: transfer.completed ? hoursAgo(transfer.hoursOld - 0.2) : null,
        executableAt:
          transfer.executableIn === null
            ? null
            : new Date(Date.now() + transfer.executableIn * 3_600_000),
        attempts: transfer.completed ? 1 : 0,
        signatures: {
          create: VALIDATORS.slice(0, transfer.signatures).map((validator, position) => ({
            validator,
            signature: fakeHash(`sig${index}`, position),
          })),
        },
      },
    });
  }

  console.log('\ndone.');
  console.log(`  ${presales.length} presales, ${locks.length} locks, ${transfers.length} transfers`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
