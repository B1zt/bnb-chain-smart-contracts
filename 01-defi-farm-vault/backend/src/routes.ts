import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {masterChefAbi, vaultAbi} from './chain/abis.js';
import {publicClient} from './chain/client.js';
import {config, keeperEnabled} from './config.js';
import {prisma} from './lib/prisma.js';
import {aprToApy} from './pricing.js';

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async (_request, reply) =>
    reply.send({
      chainId: config.CHAIN_ID,
      rewardToken: config.REWARD_TOKEN_ADDRESS,
      masterChef: config.MASTERCHEF_ADDRESS,
      oracle: config.ORACLE_ADDRESS ?? null,
      vault: config.VAULT_ADDRESS ?? null,
      router: config.ROUTER_ADDRESS,
      keeperEnabled,
    }),
  );

  /*//////////////////////////////////////////////////////////////
                                 POOLS
  //////////////////////////////////////////////////////////////*/

  /** Every pool with its cached TVL and APR. This is the farm grid. */
  app.get('/pools', async (request, reply) => {
    const schema = z.object({
      activeOnly: z.coerce.boolean().default(false),
      sort: z.enum(['apr', 'tvl', 'id']).default('apr'),
    });

    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {activeOnly, sort} = parsed.data;

    const pools = await prisma.pool.findMany({
      where: activeOnly ? {isActive: true} : {},
      orderBy:
        sort === 'apr' ? {aprBps: 'desc'} : sort === 'tvl' ? {tvlUsd: 'desc'} : {id: 'asc'},
    });

    const totalTvl = pools.reduce((sum, pool) => sum + BigInt(pool.tvlUsd ?? '0'), 0n);

    return reply.send({
      pools: pools.map((pool) => ({
        ...pool,
        // APY is derived here so the daily-compounding assumption stays visible rather than being
        // baked into the stored number.
        apyBps: Math.round(aprToApy(pool.aprBps)),
      })),
      totalTvlUsd: totalTvl.toString(),
    });
  });

  app.get('/pools/:id', async (request, reply) => {
    const {id} = request.params as {id: string};
    const poolId = Number(id);

    if (!Number.isInteger(poolId) || poolId < 0) {
      return reply.status(400).send({error: 'INVALID_POOL_ID'});
    }

    const pool = await prisma.pool.findUnique({where: {id: poolId}});
    if (!pool) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    const [snapshots, stakerCount] = await Promise.all([
      prisma.poolSnapshot.findMany({
        where: {poolId},
        orderBy: {capturedAt: 'asc'},
        take: 500,
      }),
      prisma.position.count({where: {poolId, amount: {not: '0'}}}),
    ]);

    return reply.send({
      pool: {...pool, apyBps: Math.round(aprToApy(pool.aprBps))},
      stakerCount,
      history: snapshots,
    });
  });

  /**
   * A wallet's position in one pool.
   *
   * Pending rewards and the harvest unlock are read live. They change every second, so any stored
   * value is wrong the moment it is written, and a UI showing a stale claimable amount produces
   * transactions that revert.
   */
  app.get('/pools/:id/position/:address', async (request, reply) => {
    const params = request.params as {id: string; address: string};
    const poolId = Number(params.id);
    const address = params.address.toLowerCase() as `0x${string}`;

    const [onChain, pending, unlockIn, stored] = await Promise.all([
      publicClient.readContract({
        address: config.MASTERCHEF_ADDRESS,
        abi: masterChefAbi,
        functionName: 'userInfo',
        args: [BigInt(poolId), address],
      }),
      publicClient.readContract({
        address: config.MASTERCHEF_ADDRESS,
        abi: masterChefAbi,
        functionName: 'pendingReward',
        args: [BigInt(poolId), address],
      }),
      publicClient.readContract({
        address: config.MASTERCHEF_ADDRESS,
        abi: masterChefAbi,
        functionName: 'harvestUnlockIn',
        args: [BigInt(poolId), address],
      }),
      prisma.position.findUnique({where: {poolId_address: {poolId, address}}}),
    ]);

    return reply.send({
      poolId,
      address,
      amount: onChain[0].toString(),
      pendingReward: pending.toString(),
      harvestUnlockIn: Number(unlockIn),
      totalHarvested: stored?.totalHarvested ?? '0',
    });
  });

  /** Everything a wallet has across every pool, for a portfolio view. */
  app.get('/portfolio/:address', async (request, reply) => {
    const {address} = request.params as {address: string};
    const wallet = address.toLowerCase() as `0x${string}`;

    const positions = await prisma.position.findMany({
      where: {address: wallet, amount: {not: '0'}},
      include: {pool: true},
    });

    // Pending rewards read live, batched by viem into a single multicall.
    const pending = await Promise.all(
      positions.map((position) =>
        publicClient
          .readContract({
            address: config.MASTERCHEF_ADDRESS,
            abi: masterChefAbi,
            functionName: 'pendingReward',
            args: [BigInt(position.poolId), wallet],
          })
          .catch(() => 0n),
      ),
    );

    const vaultPosition = config.VAULT_ADDRESS
      ? await prisma.vaultPosition.findUnique({where: {address: wallet}})
      : null;

    let vaultAssets = '0';
    if (config.VAULT_ADDRESS && vaultPosition && BigInt(vaultPosition.shares) > 0n) {
      const assets = await publicClient
        .readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'convertToAssets',
          args: [BigInt(vaultPosition.shares)],
        })
        .catch(() => 0n);
      vaultAssets = assets.toString();
    }

    return reply.send({
      address: wallet,
      positions: positions.map((position, index) => ({
        ...position,
        pendingReward: pending[index]!.toString(),
      })),
      totalPendingReward: pending.reduce((sum, value) => sum + value, 0n).toString(),
      vault: vaultPosition
        ? {
            shares: vaultPosition.shares,
            assets: vaultAssets,
            netDeposited: vaultPosition.netDeposited,
            unrealisedGain: (BigInt(vaultAssets) - BigInt(vaultPosition.netDeposited)).toString(),
          }
        : null,
    });
  });

  /** Recent farm activity, for an activity feed. */
  app.get('/activity', async (request, reply) => {
    const schema = z.object({
      poolId: z.coerce.number().int().nonnegative().optional(),
      address: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    });

    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {poolId, address, limit, cursor} = parsed.data;

    const events = await prisma.farmEvent.findMany({
      where: {
        ...(poolId !== undefined ? {poolId} : {}),
        ...(address ? {address: address.toLowerCase()} : {}),
      },
      include: {pool: {select: {name: true}}},
      orderBy: [{blockTime: 'desc'}, {logIndex: 'desc'}],
      take: limit + 1,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
    });

    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;

    return reply.send({
      activity: page,
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    });
  });

  /*//////////////////////////////////////////////////////////////
                                 VAULT
  //////////////////////////////////////////////////////////////*/

  app.get('/vault', async (_request, reply) => {
    if (!config.VAULT_ADDRESS) {
      return reply.status(404).send({error: 'NO_VAULT_CONFIGURED'});
    }

    const [totalAssets, totalShares, pricePerShare, pending, bounty, sinceCompound, paused] =
      await Promise.all([
        publicClient.readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'totalAssets',
        }),
        publicClient.readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'totalSupply',
        }),
        publicClient.readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'pricePerShare',
        }),
        publicClient.readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'pendingRewards',
        }),
        publicClient.readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'callerBounty',
        }),
        publicClient.readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'timeSinceCompound',
        }),
        publicClient.readContract({
          address: config.VAULT_ADDRESS,
          abi: vaultAbi,
          functionName: 'paused',
        }),
      ]);

    return reply.send({
      address: config.VAULT_ADDRESS,
      totalAssets: totalAssets.toString(),
      totalShares: totalShares.toString(),
      pricePerShare: pricePerShare.toString(),
      pendingRewards: pending.toString(),
      // Surfaced so anyone can decide whether calling compound themselves is worth the gas.
      callerBounty: bounty.toString(),
      secondsSinceCompound: Number(sinceCompound),
      paused,
    });
  });

  /** Share price over time. This is where the vault's realised yield actually shows up. */
  app.get('/vault/history', async (_request, reply) => {
    const snapshots = await prisma.vaultSnapshot.findMany({
      orderBy: {capturedAt: 'asc'},
      take: 500,
    });

    return reply.send({snapshots});
  });

  /*//////////////////////////////////////////////////////////////
                                KEEPER
  //////////////////////////////////////////////////////////////*/

  /**
   * Keeper run history.
   *
   * Exposed deliberately: a keeper that silently loses money is worse than no keeper, so its
   * decisions and their inputs are visible rather than buried in logs.
   */
  app.get('/keeper/runs', async (request, reply) => {
    const schema = z.object({
      outcome: z.enum(['SUCCESS', 'SKIPPED_UNPROFITABLE', 'FAILED']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    });

    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {outcome, limit} = parsed.data;

    const runs = await prisma.compoundRun.findMany({
      where: outcome ? {outcome} : {},
      orderBy: {createdAt: 'desc'},
      take: limit,
    });

    const [successes, skipped, failures] = await Promise.all([
      prisma.compoundRun.count({where: {outcome: 'SUCCESS'}}),
      prisma.compoundRun.count({where: {outcome: 'SKIPPED_UNPROFITABLE'}}),
      prisma.compoundRun.count({where: {outcome: 'FAILED'}}),
    ]);

    return reply.send({
      runs,
      summary: {successes, skipped, failures, enabled: keeperEnabled},
    });
  });
}
