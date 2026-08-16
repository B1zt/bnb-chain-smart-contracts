import type {FastifyInstance, FastifyRequest} from 'fastify';
import {concatHex, encodeAbiParameters, keccak256, type Address, type Hex} from 'viem';
import {z} from 'zod';
import {bridgeAbi, presaleAbi} from './chain/abis.js';
import {clientFor} from './chain/client.js';
import {config, relayerEnabled} from './config.js';
import {prisma} from './lib/prisma.js';

const addressParam = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'invalid address');

/*//////////////////////////////////////////////////////////////
                          TIER MERKLE TREE
//////////////////////////////////////////////////////////////*/

/**
 * Merkle tree over presale tier entries, matching `Presale._walletCap` exactly.
 *
 * Leaves are `keccak256(keccak256(abi.encode(address, allowanceUsd)))`, pairs are sorted before
 * hashing, and odd nodes are promoted rather than duplicated. Get any of those wrong and the API
 * serves proofs that look fine while every gated contribution reverts on-chain.
 */
function buildTierTree(entries: {address: Address; allowanceUsd: bigint}[]) {
  if (entries.length === 0) throw new Error('no entries');

  const leafFor = (entry: {address: Address; allowanceUsd: bigint}): Hex =>
    keccak256(
      keccak256(
        encodeAbiParameters([{type: 'address'}, {type: 'uint256'}], [entry.address, entry.allowanceUsd]),
      ),
    );

  // Commutative hash, matching OpenZeppelin's `Hashes.commutativeKeccak256`.
  const hashPair = (a: Hex, b: Hex): Hex =>
    a < b ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));

  // Sorted by leaf so the tree is deterministic: the same entry set always yields the same root,
  // and a rebuild does not invalidate proofs already issued.
  const decorated = entries
    .map((entry) => ({entry, leaf: leafFor(entry)}))
    .sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));

  const layers: Hex[][] = [decorated.map((item) => item.leaf)];

  while (layers[layers.length - 1]!.length > 1) {
    const layer = layers[layers.length - 1]!;
    const next: Hex[] = [];

    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = layer[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }

    layers.push(next);
  }

  const indexByAddress = new Map(
    decorated.map((item, index) => [item.entry.address.toLowerCase(), index]),
  );

  return {
    root: layers[layers.length - 1]![0]!,
    size: decorated.length,
    order: decorated.map((item) => item.entry),
    proofFor(address: string): Hex[] | null {
      const start = indexByAddress.get(address.toLowerCase());
      if (start === undefined) return null;

      const proof: Hex[] = [];
      let position = start;

      for (let level = 0; level < layers.length - 1; level += 1) {
        const layer = layers[level]!;
        const sibling = position ^ 1;

        // A promoted odd node has no sibling and contributes nothing.
        if (sibling < layer.length) proof.push(layer[sibling]!);
        position = Math.floor(position / 2);
      }

      return proof;
    },
  };
}

function requireAdmin(request: FastifyRequest): boolean {
  if (!config.ADMIN_API_KEY) return false;
  return request.headers.authorization === `Bearer ${config.ADMIN_API_KEY}`;
}

/*//////////////////////////////////////////////////////////////
                                ROUTES
//////////////////////////////////////////////////////////////*/

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async (_request, reply) =>
    reply.send({
      chainId: config.CHAIN_ID,
      factory: config.FACTORY_ADDRESS,
      locker: config.LOCKER_ADDRESS,
      priceFeed: config.PRICE_FEED_ADDRESS ?? null,
      bridge: {
        enabled: relayerEnabled,
        sourceChainId: config.SOURCE_CHAIN_ID,
        destinationChainId: config.DESTINATION_CHAIN_ID,
        sourceBridge: config.SOURCE_BRIDGE_ADDRESS ?? null,
        destinationBridge: config.DESTINATION_BRIDGE_ADDRESS ?? null,
      },
    }),
  );

  /*//////////////////////////////////////////////////////////////
                              LAUNCHPAD
  //////////////////////////////////////////////////////////////*/

  app.get('/presales', async (request, reply) => {
    const schema = z.object({
      status: z.enum(['PENDING', 'LIVE', 'SUCCEEDED', 'FAILED', 'FINALISED']).optional(),
      verifiedOnly: z.coerce.boolean().default(false),
      creator: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().optional(),
    });

    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {status, verifiedOnly, creator, limit, cursor} = parsed.data;

    const presales = await prisma.presale.findMany({
      where: {
        ...(status ? {status} : {}),
        ...(verifiedOnly ? {isVerified: true} : {}),
        ...(creator ? {creator: creator.toLowerCase()} : {}),
      },
      orderBy: [{status: 'asc'}, {endTime: 'asc'}],
      take: limit + 1,
      ...(cursor ? {cursor: {address: cursor}, skip: 1} : {}),
    });

    const hasMore = presales.length > limit;
    const page = hasMore ? presales.slice(0, limit) : presales;

    return reply.send({
      presales: page.map((presale) => ({
        ...presale,
        progressBps: Number(
          (BigInt(presale.raisedUsd) * 10_000n) / (BigInt(presale.hardCapUsd) || 1n),
        ),
        softCapReached: BigInt(presale.raisedUsd) >= BigInt(presale.softCapUsd),
      })),
      nextCursor: hasMore ? page[page.length - 1]?.address : null,
    });
  });

  app.get('/presales/:address', async (request, reply) => {
    const {address} = request.params as {address: string};

    const presale = await prisma.presale.findUnique({
      where: {address: address.toLowerCase()},
      include: {contributions: {orderBy: {blockTime: 'desc'}, take: 50}},
    });

    if (!presale) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    // Status and raise are read live. A sale that misses its soft cap simply reaches its end time
    // and emits nothing, so an indexed status would be stale for exactly the sales users care about.
    const client = clientFor(config.CHAIN_ID);

    const [statusIndex, raised] = await Promise.all([
      client
        .readContract({address: address as Address, abi: presaleAbi, functionName: 'status'})
        .catch(() => null),
      client
        .readContract({address: address as Address, abi: presaleAbi, functionName: 'totalRaisedUsd'})
        .catch(() => null),
    ]);

    const liveRaised = raised?.toString() ?? presale.raisedUsd;

    // Locks on the sale's token, so a buyer can verify liquidity claims independently rather than
    // taking the project's word for them.
    const locks = await prisma.lock.findMany({
      where: {token: presale.token, withdrawn: false},
      orderBy: {unlockAt: 'asc'},
    });

    return reply.send({
      presale: {
        ...presale,
        raisedUsd: liveRaised,
        status:
          statusIndex !== null
            ? (['PENDING', 'LIVE', 'SUCCEEDED', 'FAILED', 'FINALISED'][Number(statusIndex)] ??
              presale.status)
            : presale.status,
        progressBps: Number((BigInt(liveRaised) * 10_000n) / (BigInt(presale.hardCapUsd) || 1n)),
        softCapReached: BigInt(liveRaised) >= BigInt(presale.softCapUsd),
      },
      locks,
    });
  });

  /** A wallet's position in a sale, read live so a claim button is never offered wrongly. */
  app.get('/presales/:address/position/:wallet', async (request, reply) => {
    const params = request.params as {address: string; wallet: string};
    const presaleAddress = params.address.toLowerCase() as Address;
    const wallet = params.wallet.toLowerCase() as Address;

    const client = clientFor(config.CHAIN_ID);

    const [contributed, tokens, claimed] = await Promise.all([
      client
        .readContract({
          address: presaleAddress,
          abi: presaleAbi,
          functionName: 'contributedUsd',
          args: [wallet],
        })
        .catch(() => 0n),
      client
        .readContract({
          address: presaleAddress,
          abi: presaleAbi,
          functionName: 'tokensFor',
          args: [wallet],
        })
        .catch(() => 0n),
      client
        .readContract({
          address: presaleAddress,
          abi: presaleAbi,
          functionName: 'hasClaimed',
          args: [wallet],
        })
        .catch(() => false),
    ]);

    // The wallet's tier, if the sale is gated.
    const tier = await prisma.presaleTier.findUnique({
      where: {presaleAddress_address: {presaleAddress, address: wallet}},
    });

    return reply.send({
      contributedUsd: contributed.toString(),
      tokenAllocation: tokens.toString(),
      hasClaimed: claimed,
      tier: tier ? {allowanceUsd: tier.allowanceUsd} : null,
    });
  });

  /*//////////////////////////////////////////////////////////////
                                TIERS
  //////////////////////////////////////////////////////////////*/

  /**
   * Upload an allowlist and get the root to publish on-chain.
   *
   * Privileged: this decides who can buy and how much. A 401 rather than open access.
   */
  app.post('/presales/:address/tiers', async (request, reply) => {
    if (!requireAdmin(request)) {
      return reply.status(401).send({error: 'UNAUTHORIZED'});
    }

    const {address} = request.params as {address: string};

    const schema = z.object({
      entries: z
        .array(z.object({address: addressParam, allowanceUsd: z.string().regex(/^\d+$/)}))
        .min(1)
        .max(50_000),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_BODY', issues: parsed.error.issues});
    }

    const entries = parsed.data.entries.map((entry) => ({
      address: entry.address.toLowerCase() as Address,
      allowanceUsd: BigInt(entry.allowanceUsd),
    }));

    // Two leaves for one wallet would make only one reachable by the proof endpoint.
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.address)) {
        return reply.status(400).send({error: 'DUPLICATE_ADDRESS', address: entry.address});
      }
      seen.add(entry.address);
    }

    const tree = buildTierTree(entries);
    const presaleAddress = address.toLowerCase();

    await prisma.$transaction(async (tx) => {
      // Replacing an allowlist replaces it wholesale. Merging would leave stale entries that no
      // longer match the published root.
      await tx.presaleTier.deleteMany({where: {presaleAddress}});
      await tx.presaleTier.createMany({
        data: tree.order.map((entry, index) => ({
          presaleAddress,
          address: entry.address,
          allowanceUsd: entry.allowanceUsd.toString(),
          leafIndex: index,
        })),
      });
    });

    return reply.status(201).send({
      root: tree.root,
      entryCount: tree.size,
      nextStep: 'Set this root as the presale tierRoot before the sale opens',
    });
  });

  /**
   * Tier proof for one wallet.
   *
   * A 404 means "not on the list", which the UI renders as the default open allocation rather than
   * an error.
   */
  app.get('/presales/:address/tiers/:wallet', async (request, reply) => {
    const params = request.params as {address: string; wallet: string};
    const presaleAddress = params.address.toLowerCase();

    const rows = await prisma.presaleTier.findMany({
      where: {presaleAddress},
      orderBy: {leafIndex: 'asc'},
    });

    if (rows.length === 0) {
      return reply.status(404).send({error: 'NO_TIERS_CONFIGURED'});
    }

    const entry = rows.find((row) => row.address === params.wallet.toLowerCase());
    if (!entry) {
      return reply.status(404).send({error: 'NOT_ON_ALLOWLIST'});
    }

    // Rebuilt from stored entries. The tree is a pure function of them, so storing it too would be
    // a second source of truth that can drift.
    const tree = buildTierTree(
      rows.map((row) => ({
        address: row.address as Address,
        allowanceUsd: BigInt(row.allowanceUsd),
      })),
    );

    const proof = tree.proofFor(entry.address);
    if (!proof) {
      return reply.status(404).send({error: 'NOT_ON_ALLOWLIST'});
    }

    return reply.send({
      address: entry.address,
      allowanceUsd: entry.allowanceUsd,
      proof,
      root: tree.root,
    });
  });

  /*//////////////////////////////////////////////////////////////
                                LOCKS
  //////////////////////////////////////////////////////////////*/

  /** Locks for a token. The evidence behind a project's liquidity claims. */
  app.get('/locks/:token', async (request, reply) => {
    const {token} = request.params as {token: string};

    const locks = await prisma.lock.findMany({
      where: {token: token.toLowerCase()},
      orderBy: {unlockAt: 'asc'},
    });

    const totalLocked = locks
      .filter((lock) => !lock.withdrawn)
      .reduce((sum, lock) => sum + BigInt(lock.amount), 0n);

    return reply.send({
      locks,
      totalLocked: totalLocked.toString(),
      activeLocks: locks.filter((lock) => !lock.withdrawn).length,
    });
  });

  /*//////////////////////////////////////////////////////////////
                                BRIDGE
  //////////////////////////////////////////////////////////////*/

  /**
   * Status of a cross-chain transfer.
   *
   * The lifecycle is exposed verbatim rather than collapsed into "pending" or "done". A user
   * watching their money move between chains deserves to know whether it is waiting on
   * confirmations, on validator signatures, or on a deliberate delay.
   */
  app.get('/bridge/transfers/:messageHash', async (request, reply) => {
    const {messageHash} = request.params as {messageHash: string};

    const transfer = await prisma.bridgeTransfer.findUnique({
      where: {messageHash},
      include: {signatures: {select: {validator: true, createdAt: true}}},
    });

    if (!transfer) {
      return reply.status(404).send({error: 'NOT_FOUND'});
    }

    return reply.send({
      transfer: {
        ...transfer,
        signatureCount: transfer.signatures.length,
        requiredSignatures: config.BRIDGE_THRESHOLD,
        requiredConfirmations: config.BRIDGE_CONFIRMATIONS,
      },
    });
  });

  /** Transfers for a wallet, either side. */
  app.get('/bridge/transfers', async (request, reply) => {
    const schema = z.object({
      address: z.string().optional(),
      status: z
        .enum(['OBSERVED', 'CONFIRMED', 'SIGNED', 'SUBMITTED', 'COMPLETED', 'DELAYED', 'FAILED'])
        .optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    });

    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({error: 'INVALID_QUERY', issues: parsed.error.issues});
    }

    const {address, status, limit} = parsed.data;
    const wallet = address?.toLowerCase();

    const transfers = await prisma.bridgeTransfer.findMany({
      where: {
        ...(wallet ? {OR: [{sender: wallet}, {recipient: wallet}]} : {}),
        ...(status ? {status} : {}),
      },
      include: {_count: {select: {signatures: true}}},
      orderBy: {createdAt: 'desc'},
      take: limit,
    });

    return reply.send({
      transfers: transfers.map((transfer) => ({
        ...transfer,
        signatureCount: transfer._count.signatures,
        requiredSignatures: config.BRIDGE_THRESHOLD,
      })),
    });
  });

  /** Bridge health, so a UI can warn before someone sends funds into a stalled bridge. */
  app.get('/bridge/status', async (_request, reply) => {
    // Deliberately not gated on the relayer. Pause state, threshold and the validator set are
    // public on-chain facts, and a viewer who wants to check them should not have to be the party
    // holding a signing key. What the relayer's absence means is that nothing will be submitted
    // automatically, which is reported separately below.
    if (!config.DESTINATION_BRIDGE_ADDRESS) {
      return reply.send({enabled: false});
    }

    const destination = clientFor(config.DESTINATION_CHAIN_ID);

    const [paused, threshold, validators] = await Promise.all([
      destination
        .readContract({
          address: config.DESTINATION_BRIDGE_ADDRESS,
          abi: bridgeAbi,
          functionName: 'paused',
        })
        .catch(() => null),
      destination
        .readContract({
          address: config.DESTINATION_BRIDGE_ADDRESS,
          abi: bridgeAbi,
          functionName: 'threshold',
        })
        .catch(() => null),
      destination
        .readContract({
          address: config.DESTINATION_BRIDGE_ADDRESS,
          abi: bridgeAbi,
          functionName: 'validators',
        })
        .catch(() => null),
    ]);

    const [pending, failed] = await Promise.all([
      prisma.bridgeTransfer.count({
        where: {status: {in: ['OBSERVED', 'CONFIRMED', 'SIGNED', 'SUBMITTED', 'DELAYED']}},
      }),
      prisma.bridgeTransfer.count({where: {status: 'FAILED'}}),
    ]);

    return reply.send({
      enabled: true,
      relayerEnabled,
      paused,
      onChainThreshold: threshold ? Number(threshold) : null,
      validatorCount: validators?.length ?? null,
      // A mismatch means the relayer will gather too few or too many signatures, and every
      // submission will revert. Worth surfacing rather than debugging from logs.
      thresholdMatchesConfig: threshold ? Number(threshold) === config.BRIDGE_THRESHOLD : null,
      pendingTransfers: pending,
      failedTransfers: failed,
    });
  });
}
