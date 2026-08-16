import type {Address, Hex} from 'viem';
import {
  bridgeAbi,
  erc20Abi,
  factoryAbi,
  lockerAbi,
  presaleAbi,
  PRESALE_STATUS,
} from '../chain/abis.js';
import {clientFor, getHeadBlock} from '../chain/client.js';
import {config, relayerEnabled} from '../config.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';

/**
 * Indexer for the launchpad and the bridge's source chain.
 *
 * Reorg-safe in the same way as the other projects here: the cursor holds the highest **final**
 * block, non-final rows are deleted and re-scanned on every pass, and every write is keyed on
 * `(txHash, logIndex)` so replaying a range is a no-op.
 *
 * The presale-specific wrinkle is that a sale's status changes with the passage of time, not by
 * emitting an event. A sale that fails its soft cap simply reaches its end time; nothing is logged.
 * Purely event-driven status would therefore be permanently stale for exactly the sales a user is
 * most likely to be looking at, so live statuses are refreshed on a timer.
 */
export class Indexer {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info({chainId: config.CHAIN_ID, confirmations: config.CONFIRMATIONS}, 'indexer starting');

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
    await this.syncFactory();
    await this.syncPresales();
    await this.syncLocker();

    if (relayerEnabled) {
      await this.syncBridgeSource();
    }

    await this.refreshPresaleStatuses();
  }

  /*//////////////////////////////////////////////////////////////
                               FACTORY
  //////////////////////////////////////////////////////////////*/

  /** Discover new presales from the factory. */
  private async syncFactory(): Promise<void> {
    const client = clientFor(config.CHAIN_ID);
    const head = await getHeadBlock(config.CHAIN_ID);
    const safeBlock = this.safeBlock(head);

    const cursor = await this.readCursor('factory', config.FACTORY_ADDRESS, config.CHAIN_ID);
    if (cursor + 1n > head) return;

    let current = cursor + 1n;
    const batch = BigInt(config.INDEXER_BATCH_SIZE);

    while (current <= head) {
      const toBlock = current + batch - 1n > head ? head : current + batch - 1n;

      const logs = await client.getLogs({
        address: config.FACTORY_ADDRESS,
        events: factoryAbi.filter((item) => item.type === 'event'),
        fromBlock: current,
        toBlock,
      });

      for (const log of logs) {
        const decoded = log as unknown as {eventName: string; args: Record<string, unknown>};

        if (decoded.eventName === 'PresaleCreated') {
          await this.upsertPresale(decoded.args.presale as Address);
        }

        if (decoded.eventName === 'PresaleVerified') {
          await prisma.presale.updateMany({
            where: {address: (decoded.args.presale as string).toLowerCase()},
            data: {isVerified: decoded.args.verified as boolean},
          });
        }
      }

      current = toBlock + 1n;
    }

    await this.writeCursor('factory', config.FACTORY_ADDRESS, config.CHAIN_ID, safeBlock);
  }

  /** Read a presale's immutable config and current state from chain. */
  private async upsertPresale(address: Address): Promise<void> {
    const client = clientFor(config.CHAIN_ID);

    const [saleConfig, owner, statusIndex, raised, contributors] = await Promise.all([
      client.readContract({address, abi: presaleAbi, functionName: 'config'}),
      client.readContract({address, abi: presaleAbi, functionName: 'owner'}),
      client.readContract({address, abi: presaleAbi, functionName: 'status'}),
      client.readContract({address, abi: presaleAbi, functionName: 'totalRaisedUsd'}),
      client.readContract({address, abi: presaleAbi, functionName: 'contributorCount'}),
    ]);

    const token = saleConfig[0] as Address;

    // Token metadata is read once and cached on the row. It cannot change, and a launchpad listing
    // showing a raw address instead of a symbol is close to useless.
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({address: token, abi: erc20Abi, functionName: 'symbol'}).catch(() => null),
      client.readContract({address: token, abi: erc20Abi, functionName: 'name'}).catch(() => null),
      client.readContract({address: token, abi: erc20Abi, functionName: 'decimals'}).catch(() => 18),
    ]);

    await prisma.presale.upsert({
      where: {address: address.toLowerCase()},
      create: {
        address: address.toLowerCase(),
        creator: owner.toLowerCase(),
        token: token.toLowerCase(),
        tokenSymbol: symbol,
        tokenName: name,
        tokenDecimals: Number(decimals),
        tokensPerUsd: saleConfig[1].toString(),
        softCapUsd: saleConfig[2].toString(),
        hardCapUsd: saleConfig[3].toString(),
        minContributionUsd: saleConfig[4].toString(),
        maxContributionUsd: saleConfig[5].toString(),
        startTime: new Date(Number(saleConfig[6]) * 1000),
        endTime: new Date(Number(saleConfig[7]) * 1000),
        tierRoot: saleConfig[8],
        raisedUsd: raised.toString(),
        contributorCount: Number(contributors),
        status: PRESALE_STATUS[Number(statusIndex)] ?? 'PENDING',
      },
      update: {
        raisedUsd: raised.toString(),
        contributorCount: Number(contributors),
        status: PRESALE_STATUS[Number(statusIndex)] ?? 'PENDING',
      },
    });
  }

  /*//////////////////////////////////////////////////////////////
                             CONTRIBUTIONS
  //////////////////////////////////////////////////////////////*/

  /** Index contribution logs across every known presale. */
  private async syncPresales(): Promise<void> {
    const presales = await prisma.presale.findMany({
      where: {status: {in: ['PENDING', 'LIVE', 'SUCCEEDED']}},
      select: {address: true},
    });
    if (presales.length === 0) return;

    const client = clientFor(config.CHAIN_ID);
    const head = await getHeadBlock(config.CHAIN_ID);
    const safeBlock = this.safeBlock(head);

    for (const {address} of presales) {
      const cursor = await this.readCursor(`presale:${address}`, address, config.CHAIN_ID);
      if (cursor + 1n > head) continue;

      // Drop non-final contributions for this sale before re-scanning.
      await prisma.contribution.deleteMany({
        where: {presaleAddress: address, blockNumber: {gt: safeBlock}},
      });

      let current = cursor + 1n;
      const batch = BigInt(config.INDEXER_BATCH_SIZE);

      while (current <= head) {
        const toBlock = current + batch - 1n > head ? head : current + batch - 1n;

        const logs = await client.getLogs({
          address: address as Address,
          events: presaleAbi.filter(
            (item) => item.type === 'event' && item.name === 'Contributed',
          ),
          fromBlock: current,
          toBlock,
        });

        if (logs.length > 0) {
          const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!))];
          const blocks = await Promise.all(
            blockNumbers.map((blockNumber) => client.getBlock({blockNumber})),
          );
          const timeByBlock = new Map(
            blocks.map((block) => [block.number!, new Date(Number(block.timestamp) * 1000)]),
          );

          for (const log of logs) {
            const decoded = log as unknown as {
              args: {contributor: Address; currency: Address; amount: bigint; usdValue: bigint};
              transactionHash: Hex;
              logIndex: number;
              blockNumber: bigint;
            };

            await prisma.contribution.upsert({
              where: {
                txHash_logIndex: {
                  txHash: decoded.transactionHash,
                  logIndex: decoded.logIndex,
                },
              },
              create: {
                presaleAddress: address,
                contributor: decoded.args.contributor.toLowerCase(),
                currency: decoded.args.currency.toLowerCase(),
                amount: decoded.args.amount.toString(),
                usdValue: decoded.args.usdValue.toString(),
                txHash: decoded.transactionHash,
                logIndex: decoded.logIndex,
                blockNumber: decoded.blockNumber,
                blockTime: timeByBlock.get(decoded.blockNumber) ?? new Date(),
              },
              update: {},
            });
          }
        }

        current = toBlock + 1n;
      }

      await this.writeCursor(`presale:${address}`, address, config.CHAIN_ID, safeBlock);

      // Totals come from the contract rather than being summed locally. Summing contributions is
      // one place where a missed log silently produces a wrong raise figure.
      await this.upsertPresale(address as Address);
    }
  }

  /**
   * Refresh presale statuses.
   *
   * A sale that misses its soft cap simply reaches its end time; no event fires. Anything relying
   * only on logs would show it as LIVE forever.
   */
  private async refreshPresaleStatuses(): Promise<void> {
    const open = await prisma.presale.findMany({
      where: {status: {in: ['PENDING', 'LIVE', 'SUCCEEDED']}},
      select: {address: true, status: true},
    });

    const client = clientFor(config.CHAIN_ID);

    for (const presale of open) {
      try {
        const statusIndex = await client.readContract({
          address: presale.address as Address,
          abi: presaleAbi,
          functionName: 'status',
        });

        const next = PRESALE_STATUS[Number(statusIndex)];
        if (next && next !== presale.status) {
          await prisma.presale.update({where: {address: presale.address}, data: {status: next}});
          logger.info({presale: presale.address, status: next}, 'presale status changed');
        }
      } catch (error) {
        logger.debug({error, presale: presale.address}, 'status refresh failed');
      }
    }
  }

  /*//////////////////////////////////////////////////////////////
                                LOCKER
  //////////////////////////////////////////////////////////////*/

  private async syncLocker(): Promise<void> {
    const client = clientFor(config.CHAIN_ID);
    const head = await getHeadBlock(config.CHAIN_ID);
    const safeBlock = this.safeBlock(head);

    const cursor = await this.readCursor('locker', config.LOCKER_ADDRESS, config.CHAIN_ID);
    if (cursor + 1n > head) return;

    let current = cursor + 1n;
    const batch = BigInt(config.INDEXER_BATCH_SIZE);

    while (current <= head) {
      const toBlock = current + batch - 1n > head ? head : current + batch - 1n;

      const logs = await client.getLogs({
        address: config.LOCKER_ADDRESS,
        events: lockerAbi.filter((item) => item.type === 'event'),
        fromBlock: current,
        toBlock,
      });

      for (const log of logs) {
        const decoded = log as unknown as {eventName: string; args: Record<string, unknown>};
        const lockId = (decoded.args.lockId as bigint).toString();

        // Re-read from the contract rather than reconstructing from the event. Extensions, splits
        // and transfers all mutate a lock, and replaying that history locally is needless risk.
        await this.upsertLock(lockId);
      }

      current = toBlock + 1n;
    }

    await this.writeCursor('locker', config.LOCKER_ADDRESS, config.CHAIN_ID, safeBlock);
  }

  private async upsertLock(lockId: string): Promise<void> {
    const client = clientFor(config.CHAIN_ID);

    try {
      const entry = await client.readContract({
        address: config.LOCKER_ADDRESS,
        abi: lockerAbi,
        functionName: 'locks',
        args: [BigInt(lockId)],
      });

      const symbol = await client
        .readContract({address: entry.token, abi: erc20Abi, functionName: 'symbol'})
        .catch(() => null);

      await prisma.lock.upsert({
        where: {id: lockId},
        create: {
          id: lockId,
          token: entry.token.toLowerCase(),
          tokenSymbol: symbol,
          owner: entry.owner.toLowerCase(),
          amount: entry.amount.toString(),
          lockedAt: new Date(Number(entry.lockedAt) * 1000),
          unlockAt: new Date(Number(entry.unlockAt) * 1000),
          withdrawn: entry.withdrawn,
          description: entry.description,
        },
        update: {
          owner: entry.owner.toLowerCase(),
          amount: entry.amount.toString(),
          unlockAt: new Date(Number(entry.unlockAt) * 1000),
          withdrawn: entry.withdrawn,
        },
      });
    } catch (error) {
      logger.debug({error, lockId}, 'lock read failed');
    }
  }

  /*//////////////////////////////////////////////////////////////
                            BRIDGE SOURCE
  //////////////////////////////////////////////////////////////*/

  /**
   * Record outbound transfers so the relayer has something to work from.
   *
   * Rows land in OBSERVED. The relayer promotes them to CONFIRMED only once they are deep enough
   * to be final, which is what stops a reorged deposit being minted against on the other chain.
   */
  private async syncBridgeSource(): Promise<void> {
    if (!config.SOURCE_BRIDGE_ADDRESS) return;

    const client = clientFor(config.SOURCE_CHAIN_ID);
    const head = await client.getBlockNumber();
    const safeBlock = this.safeBlock(head);

    const cursor = await this.readCursor(
      'bridge:source',
      config.SOURCE_BRIDGE_ADDRESS,
      config.SOURCE_CHAIN_ID,
    );
    if (cursor + 1n > head) return;

    let current = cursor + 1n;
    const batch = BigInt(config.INDEXER_BATCH_SIZE);

    while (current <= head) {
      const toBlock = current + batch - 1n > head ? head : current + batch - 1n;

      const logs = await client.getLogs({
        address: config.SOURCE_BRIDGE_ADDRESS,
        events: bridgeAbi.filter(
          (item) => item.type === 'event' && item.name === 'TransferInitiated',
        ),
        fromBlock: current,
        toBlock,
      });

      if (logs.length > 0) {
        const blockNumbers = [...new Set(logs.map((log) => log.blockNumber!))];
        const blocks = await Promise.all(
          blockNumbers.map((blockNumber) => client.getBlock({blockNumber})),
        );
        const timeByBlock = new Map(
          blocks.map((block) => [block.number!, new Date(Number(block.timestamp) * 1000)]),
        );

        for (const log of logs) {
          const decoded = log as unknown as {
            args: {
              messageHash: Hex;
              sender: Address;
              token: Address;
              destinationChainId: bigint;
              recipient: Address;
              amount: bigint;
              nonce: bigint;
            };
            transactionHash: Hex;
            logIndex: number;
            blockNumber: bigint;
          };

          await prisma.bridgeTransfer.upsert({
            where: {messageHash: decoded.args.messageHash},
            create: {
              messageHash: decoded.args.messageHash,
              sourceChainId: config.SOURCE_CHAIN_ID,
              destinationChainId: Number(decoded.args.destinationChainId),
              destinationBridge: (config.DESTINATION_BRIDGE_ADDRESS ?? '').toLowerCase(),
              token: decoded.args.token.toLowerCase(),
              sender: decoded.args.sender.toLowerCase(),
              recipient: decoded.args.recipient.toLowerCase(),
              amount: decoded.args.amount.toString(),
              nonce: decoded.args.nonce.toString(),
              sourceTxHash: decoded.transactionHash,
              sourceBlockNumber: decoded.blockNumber,
              sourceBlockTime: timeByBlock.get(decoded.blockNumber) ?? new Date(),
              status: 'OBSERVED',
            },
            // Never overwrite: the relayer owns this row's lifecycle from here on, and clobbering
            // its status on a re-scan would restart a transfer that is already in flight.
            update: {},
          });
        }
      }

      current = toBlock + 1n;
    }

    await this.writeCursor(
      'bridge:source',
      config.SOURCE_BRIDGE_ADDRESS,
      config.SOURCE_CHAIN_ID,
      safeBlock,
    );
  }

  /*//////////////////////////////////////////////////////////////
                                CURSOR
  //////////////////////////////////////////////////////////////*/

  private safeBlock(head: bigint): bigint {
    const confirmations = BigInt(config.CONFIRMATIONS);
    return head > confirmations ? head - confirmations : 0n;
  }

  private async readCursor(id: string, contract: string, chainId: number): Promise<bigint> {
    const row = await prisma.indexerCursor.findUnique({
      where: {contract_chainId: {contract: contract.toLowerCase(), chainId}},
    });
    if (row) return row.lastSafeBlock;

    const start = config.DEPLOY_BLOCK > 0n ? config.DEPLOY_BLOCK - 1n : 0n;

    await prisma.indexerCursor.create({
      data: {id, contract: contract.toLowerCase(), chainId, lastSafeBlock: start},
    });

    return start;
  }

  private async writeCursor(
    id: string,
    contract: string,
    chainId: number,
    block: bigint,
  ): Promise<void> {
    await prisma.indexerCursor.upsert({
      where: {contract_chainId: {contract: contract.toLowerCase(), chainId}},
      create: {id, contract: contract.toLowerCase(), chainId, lastSafeBlock: block},
      update: {lastSafeBlock: block},
    });
  }
}
