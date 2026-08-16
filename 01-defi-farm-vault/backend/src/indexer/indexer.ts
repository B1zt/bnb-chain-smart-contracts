import type {Abi, AbiEvent} from 'viem';
import {masterChefAbi, pairAbi, vaultAbi} from '../chain/abis.js';
import {getHeadBlock, publicClient} from '../chain/client.js';
import {config} from '../config.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';
import {
  calculateAprBps,
  getLpPriceUsd,
  getTokenInfo,
  getTokenPriceUsd,
  valueUsd,
} from '../pricing.js';

interface DecodedEvent {
  eventName: string;
  args: Record<string, unknown>;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  blockTime: Date;
}

interface WatchedContract {
  id: string;
  address: `0x${string}`;
  abi: Abi;
  handlers: Record<string, (event: DecodedEvent) => Promise<void>>;
}

/**
 * Log indexer with reorg-safe checkpointing, plus periodic TVL and APR sampling.
 *
 * The cursor holds the highest block considered **final**, trailing the head by `CONFIRMATIONS`.
 * Each pass deletes rows sourced from non-final blocks, re-scans from the cursor to the head, then
 * advances the cursor only as far as the safe block. Every write is keyed on `(txHash, logIndex)`,
 * so replaying a range is a no-op and the process can be killed and resumed freely.
 *
 * BSC reorgs are shallow but real, and its 3 second blocks mean a reorg is over before a human
 * notices. Without the delete-and-rescan, a deposit that was mined then orphaned would sit in the
 * database forever and the pool's TVL would count LP nobody staked.
 *
 * TVL and APR have no events to index from: they are functions of prices and emissions that drift
 * continuously. They are sampled on a timer instead.
 */
export class Indexer {
  private readonly contracts: WatchedContract[];
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;

  constructor() {
    this.contracts = [
      {
        id: 'masterchef',
        address: config.MASTERCHEF_ADDRESS,
        abi: masterChefAbi as unknown as Abi,
        handlers: {
          PoolAdded: this.handlePoolAdded,
          PoolUpdated: this.handlePoolUpdated,
          Deposit: this.handleFarmDeposit,
          Withdraw: this.handleFarmWithdraw,
          Harvest: this.handleHarvest,
          EmergencyWithdraw: this.handleEmergencyWithdraw,
        },
      },
    ];

    if (config.VAULT_ADDRESS) {
      this.contracts.push({
        id: 'vault',
        address: config.VAULT_ADDRESS,
        abi: vaultAbi as unknown as Abi,
        handlers: {
          Deposit: this.handleVaultDeposit,
          Withdraw: this.handleVaultWithdraw,
        },
      });
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info(
      {contracts: this.contracts.map((c) => c.id), confirmations: config.CONFIRMATIONS},
      'indexer starting',
    );

    // Pools are read from the contract on boot rather than relying on having indexed every
    // PoolAdded event. A database restored from a backup, or an indexer pointed at an already-live
    // farm, would otherwise show no pools at all.
    await this.syncPoolsFromChain();

    await this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    logger.info('indexer stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => logger.error({error}, 'indexer pass failed'))
        .finally(() => this.scheduleNext());
    }, config.INDEXER_POLL_INTERVAL * 1_000);
  }

  private async tick(): Promise<void> {
    const head = await getHeadBlock();
    const confirmations = BigInt(config.CONFIRMATIONS);
    const safeBlock = head > confirmations ? head - confirmations : 0n;

    for (const contract of this.contracts) {
      await this.syncContract(contract, head, safeBlock);
    }

    await this.maybeSnapshot(head);
  }

  private async syncContract(
    contract: WatchedContract,
    head: bigint,
    safeBlock: bigint,
  ): Promise<void> {
    const cursor = await this.readCursor(contract);
    const fromBlock = cursor + 1n;
    if (fromBlock > head) return;

    await this.dropProvisionalRows(safeBlock);

    const batchSize = BigInt(config.INDEXER_BATCH_SIZE);
    let current = fromBlock;
    let processed = 0;

    while (current <= head) {
      const toBlock = current + batchSize - 1n > head ? head : current + batchSize - 1n;
      processed += await this.processRange(contract, current, toBlock);
      current = toBlock + 1n;
    }

    await this.writeCursor(contract, safeBlock);

    if (processed > 0) {
      logger.info({contract: contract.id, processed, head: head.toString()}, 'indexed events');
    }
  }

  private async processRange(
    contract: WatchedContract,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<number> {
    const events = (contract.abi as readonly AbiEvent[]).filter(
      (item) => item.type === 'event' && contract.handlers[item.name] !== undefined,
    );
    if (events.length === 0) return 0;

    const logs = await publicClient.getLogs({address: contract.address, events, fromBlock, toBlock});
    if (logs.length === 0) return 0;

    // Block timestamps are not on the log, and one fetch per log would hammer the RPC.
    const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!))];
    const blocks = await Promise.all(
      blockNumbers.map((blockNumber) => publicClient.getBlock({blockNumber})),
    );
    const timeByBlock = new Map(
      blocks.map((block) => [block.number!, new Date(Number(block.timestamp) * 1000)]),
    );

    // Chain order matters: a deposit and the withdrawal that follows must apply in sequence.
    const ordered = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber! < b.blockNumber! ? -1 : 1;
      return a.logIndex! - b.logIndex!;
    });

    let processed = 0;

    for (const log of ordered) {
      const decoded = log as unknown as {
        eventName: string;
        args: Record<string, unknown>;
        transactionHash: `0x${string}`;
        logIndex: number;
        blockNumber: bigint;
      };

      const handler = contract.handlers[decoded.eventName];
      if (!handler) continue;

      try {
        await handler({
          eventName: decoded.eventName,
          args: decoded.args,
          txHash: decoded.transactionHash,
          logIndex: decoded.logIndex,
          blockNumber: decoded.blockNumber,
          blockTime: timeByBlock.get(decoded.blockNumber) ?? new Date(),
        });
        processed += 1;
      } catch (error) {
        // One bad log must not stall the pipeline.
        logger.error(
          {error, contract: contract.id, event: decoded.eventName, txHash: decoded.transactionHash},
          'handler failed',
        );
      }
    }

    return processed;
  }

  /*//////////////////////////////////////////////////////////////
                             POOL HANDLERS
  //////////////////////////////////////////////////////////////*/

  private handlePoolAdded = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {pid: bigint; lpToken: `0x${string}`};
    await this.upsertPoolFromChain(Number(args.pid), args.lpToken);
  };

  private handlePoolUpdated = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {
      pid: bigint;
      allocPoint: bigint;
      depositFeeBps: number;
      harvestLockup: number;
    };

    await prisma.pool.updateMany({
      where: {id: Number(args.pid)},
      data: {
        allocPoint: args.allocPoint.toString(),
        depositFeeBps: Number(args.depositFeeBps),
        harvestLockup: Number(args.harvestLockup),
        // Zero weight means the pool no longer earns, which the UI should show differently.
        isActive: args.allocPoint > 0n,
      },
    });
  };

  private handleFarmDeposit = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {user: `0x${string}`; pid: bigint; amount: bigint; fee: bigint};

    await this.recordFarmEvent(event, Number(args.pid), args.user, 'DEPOSIT', args.amount, args.fee);
    await this.refreshPosition(Number(args.pid), args.user);
  };

  private handleFarmWithdraw = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {user: `0x${string}`; pid: bigint; amount: bigint};

    await this.recordFarmEvent(event, Number(args.pid), args.user, 'WITHDRAW', args.amount, 0n);
    await this.refreshPosition(Number(args.pid), args.user);
  };

  private handleHarvest = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {user: `0x${string}`; pid: bigint; amount: bigint};

    const created = await this.recordFarmEvent(
      event,
      Number(args.pid),
      args.user,
      'HARVEST',
      args.amount,
      0n,
    );

    // Only accumulate on a genuinely new log. A replayed range would otherwise inflate the total.
    if (!created) return;

    const position = await prisma.position.findUnique({
      where: {poolId_address: {poolId: Number(args.pid), address: args.user.toLowerCase()}},
    });

    if (position) {
      await prisma.position.update({
        where: {id: position.id},
        data: {totalHarvested: (BigInt(position.totalHarvested) + args.amount).toString()},
      });
    }
  };

  private handleEmergencyWithdraw = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {user: `0x${string}`; pid: bigint; amount: bigint};

    await this.recordFarmEvent(
      event,
      Number(args.pid),
      args.user,
      'EMERGENCY_WITHDRAW',
      args.amount,
      0n,
    );
    await this.refreshPosition(Number(args.pid), args.user);
  };

  /** @returns true when a new row was written, false when the log had already been indexed. */
  private async recordFarmEvent(
    event: DecodedEvent,
    poolId: number,
    address: `0x${string}`,
    kind: string,
    amount: bigint,
    fee: bigint,
  ): Promise<boolean> {
    const existing = await prisma.farmEvent.findUnique({
      where: {txHash_logIndex: {txHash: event.txHash, logIndex: event.logIndex}},
    });
    if (existing) return false;

    // A pool row must exist for the foreign key. It normally will, but an indexer started mid-life
    // can see a Deposit before it has seen the PoolAdded that created the pool.
    const pool = await prisma.pool.findUnique({where: {id: poolId}});
    if (!pool) {
      await this.syncPoolsFromChain();
    }

    await prisma.farmEvent.create({
      data: {
        poolId,
        address: address.toLowerCase(),
        kind,
        amount: amount.toString(),
        fee: fee.toString(),
        txHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        blockTime: event.blockTime,
      },
    });

    return true;
  }

  /**
   * Re-read a position from the contract rather than adding and subtracting locally.
   *
   * Deposit fees mean the credited amount differs from the amount sent, and fee-on-transfer LP
   * tokens make it differ again. Reading the authoritative value costs one call and cannot drift.
   */
  private async refreshPosition(poolId: number, address: `0x${string}`): Promise<void> {
    const [amount] = await publicClient.readContract({
      address: config.MASTERCHEF_ADDRESS,
      abi: masterChefAbi,
      functionName: 'userInfo',
      args: [BigInt(poolId), address],
    });

    await prisma.position.upsert({
      where: {poolId_address: {poolId, address: address.toLowerCase()}},
      create: {poolId, address: address.toLowerCase(), amount: amount.toString()},
      update: {amount: amount.toString()},
    });
  }

  /*//////////////////////////////////////////////////////////////
                            VAULT HANDLERS
  //////////////////////////////////////////////////////////////*/

  private handleVaultDeposit = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {owner: `0x${string}`; assets: bigint; shares: bigint};
    await this.updateVaultPosition(args.owner, args.assets, args.shares, 1n);
  };

  private handleVaultWithdraw = async (event: DecodedEvent): Promise<void> => {
    const args = event.args as {owner: `0x${string}`; assets: bigint; shares: bigint};
    await this.updateVaultPosition(args.owner, args.assets, args.shares, -1n);
  };

  private async updateVaultPosition(
    owner: `0x${string}`,
    assets: bigint,
    shares: bigint,
    sign: bigint,
  ): Promise<void> {
    if (!config.VAULT_ADDRESS) return;

    const address = owner.toLowerCase();

    // Shares come from the contract, so a partial withdrawal cannot drift. Net deposited is
    // accumulated locally because it is a cost basis the contract does not track.
    const currentShares = await publicClient.readContract({
      address: config.VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [owner],
    });

    const existing = await prisma.vaultPosition.findUnique({where: {address}});
    const netDeposited = BigInt(existing?.netDeposited ?? '0') + sign * assets;

    await prisma.vaultPosition.upsert({
      where: {address},
      create: {
        address,
        shares: currentShares.toString(),
        netDeposited: (netDeposited > 0n ? netDeposited : 0n).toString(),
      },
      update: {
        shares: currentShares.toString(),
        netDeposited: (netDeposited > 0n ? netDeposited : 0n).toString(),
      },
    });

    // Silence the unused-parameter warning without dropping it from the signature, which documents
    // that the event carries shares even though the contract is the authority on them.
    void shares;
  }

  /*//////////////////////////////////////////////////////////////
                          POOLS AND SNAPSHOTS
  //////////////////////////////////////////////////////////////*/

  /** Read every pool from the contract, so the database matches chain state on boot. */
  private async syncPoolsFromChain(): Promise<void> {
    const length = await publicClient.readContract({
      address: config.MASTERCHEF_ADDRESS,
      abi: masterChefAbi,
      functionName: 'poolLength',
    });

    for (let pid = 0; pid < Number(length); pid += 1) {
      const info = await publicClient.readContract({
        address: config.MASTERCHEF_ADDRESS,
        abi: masterChefAbi,
        functionName: 'poolInfo',
        args: [BigInt(pid)],
      });

      await this.upsertPoolFromChain(pid, info[0]);
    }
  }

  private async upsertPoolFromChain(pid: number, lpToken: `0x${string}`): Promise<void> {
    const info = await publicClient.readContract({
      address: config.MASTERCHEF_ADDRESS,
      abi: masterChefAbi,
      functionName: 'poolInfo',
      args: [BigInt(pid)],
    });

    const [, allocPoint, , , depositFeeBps, harvestLockup, lpSupply] = info;

    // Resolve the pair's sides for a readable name. A pool listed as "0x7EF3..." helps nobody.
    let name: string | null = null;
    let token0: string | null = null;
    let token1: string | null = null;
    let token0Symbol: string | null = null;
    let token1Symbol: string | null = null;

    try {
      const [t0, t1] = await Promise.all([
        publicClient.readContract({address: lpToken, abi: pairAbi, functionName: 'token0'}),
        publicClient.readContract({address: lpToken, abi: pairAbi, functionName: 'token1'}),
      ]);

      const [info0, info1] = await Promise.all([getTokenInfo(t0), getTokenInfo(t1)]);

      token0 = t0.toLowerCase();
      token1 = t1.toLowerCase();
      token0Symbol = info0.symbol;
      token1Symbol = info1.symbol;
      name = `${info0.symbol}-${info1.symbol}`;
    } catch {
      // Not every staked token is an LP pair. A single-asset pool is legitimate, so fall back to
      // its own symbol rather than treating this as an error.
      const info = await getTokenInfo(lpToken);
      name = info.symbol;
    }

    await prisma.pool.upsert({
      where: {id: pid},
      create: {
        id: pid,
        lpToken: lpToken.toLowerCase(),
        name,
        token0,
        token1,
        token0Symbol,
        token1Symbol,
        allocPoint: allocPoint.toString(),
        depositFeeBps: Number(depositFeeBps),
        harvestLockup: Number(harvestLockup),
        lpSupply: lpSupply.toString(),
        isActive: allocPoint > 0n,
      },
      update: {
        allocPoint: allocPoint.toString(),
        depositFeeBps: Number(depositFeeBps),
        harvestLockup: Number(harvestLockup),
        lpSupply: lpSupply.toString(),
        isActive: allocPoint > 0n,
      },
    });
  }

  /**
   * Sample TVL, APR and vault share price.
   *
   * None of these emit events: they are continuous functions of prices, emissions and staked
   * balances. Sampling is the only way to have a history to chart.
   */
  private async maybeSnapshot(head: bigint): Promise<void> {
    const now = Date.now();
    if (now - this.lastSnapshotAt < config.SNAPSHOT_INTERVAL * 1_000) return;
    this.lastSnapshotAt = now;

    try {
      await this.snapshotPools();
      await this.snapshotVault(head);
    } catch (error) {
      logger.warn({error}, 'snapshot failed');
    }
  }

  private async snapshotPools(): Promise<void> {
    const pools = await prisma.pool.findMany();
    const rewardPrice = await getTokenPriceUsd(config.REWARD_TOKEN_ADDRESS);

    for (const pool of pools) {
      const info = await publicClient.readContract({
        address: config.MASTERCHEF_ADDRESS,
        abi: masterChefAbi,
        functionName: 'poolInfo',
        args: [BigInt(pool.id)],
      });
      const lpSupply = info[6];

      const rewardPerSecond = await publicClient.readContract({
        address: config.MASTERCHEF_ADDRESS,
        abi: masterChefAbi,
        functionName: 'poolRewardPerSecond',
        args: [BigInt(pool.id)],
      });

      const valuation = await getLpPriceUsd(pool.lpToken as `0x${string}`);

      let tvlUsd: bigint | null = null;
      let aprBps = 0;

      if (valuation) {
        tvlUsd = valueUsd(lpSupply, 18, valuation.priceUsd);

        if (rewardPrice !== null && tvlUsd > 0n) {
          aprBps = calculateAprBps(rewardPerSecond, rewardPrice, tvlUsd);
        }
      }

      await prisma.pool.update({
        where: {id: pool.id},
        data: {lpSupply: lpSupply.toString(), tvlUsd: tvlUsd?.toString() ?? null, aprBps},
      });

      await prisma.poolSnapshot.create({
        data: {
          poolId: pool.id,
          lpSupply: lpSupply.toString(),
          tvlUsd: tvlUsd?.toString() ?? null,
          aprBps,
          rewardPriceUsd: rewardPrice?.toString() ?? null,
          capturedAt: new Date(),
        },
      });
    }
  }

  private async snapshotVault(head: bigint): Promise<void> {
    if (!config.VAULT_ADDRESS) return;

    const [totalAssets, totalShares, pricePerShare] = await Promise.all([
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
    ]);

    await prisma.vaultSnapshot.upsert({
      where: {blockNumber: head},
      create: {
        blockNumber: head,
        totalAssets: totalAssets.toString(),
        totalShares: totalShares.toString(),
        pricePerShare: pricePerShare.toString(),
        capturedAt: new Date(),
      },
      update: {},
    });
  }

  /*//////////////////////////////////////////////////////////////
                                CURSOR
  //////////////////////////////////////////////////////////////*/

  private async dropProvisionalRows(safeBlock: bigint): Promise<void> {
    await prisma.farmEvent.deleteMany({where: {blockNumber: {gt: safeBlock}}});
  }

  private async readCursor(contract: WatchedContract): Promise<bigint> {
    const row = await prisma.indexerCursor.findUnique({where: {contract: contract.address}});
    if (row) return row.lastSafeBlock;

    const start = config.DEPLOY_BLOCK > 0n ? config.DEPLOY_BLOCK - 1n : 0n;

    await prisma.indexerCursor.create({
      data: {id: contract.id, contract: contract.address, lastSafeBlock: start},
    });

    return start;
  }

  private async writeCursor(contract: WatchedContract, block: bigint): Promise<void> {
    await prisma.indexerCursor.update({
      where: {contract: contract.address},
      data: {lastSafeBlock: block},
    });
  }
}
