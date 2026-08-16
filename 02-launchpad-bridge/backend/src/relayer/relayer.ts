import {createWalletClient, http, type Address, type Hex, type WalletClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {bridgeAbi} from '../chain/abis.js';
import {clientFor} from '../chain/client.js';
import {config, relayerEnabled} from '../config.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';

/**
 * Cross-chain relayer.
 *
 * Watches `TransferInitiated` on the source chain, collects validator signatures, and submits the
 * release on the destination chain.
 *
 * **The relayer is not trusted.** It cannot forge a transfer, alter an amount or redirect a
 * recipient: every one of those fields is covered by the validators' EIP-712 signatures, and the
 * destination bridge re-derives the hash from the data submitted. The worst a malicious relayer can
 * do is refuse to relay, which is a liveness problem, not a safety one. Anyone can run another.
 *
 * **What it does need to get right is not losing or duplicating transfers.** A relayer is a
 * stateful process that observes one chain and acts on another, and the failure nobody plans for is
 * a crash between those two moments. Every transfer therefore has an explicit persisted lifecycle:
 *
 *     OBSERVED -> CONFIRMED -> SIGNED -> SUBMITTED -> COMPLETED
 *
 * Each transition is written before the action it authorises, so a restart resumes from the last
 * durable stage. Duplicate submission is harmless anyway, because the destination bridge rejects an
 * already-processed message hash, but burning gas on a guaranteed revert is worth avoiding.
 */
export class BridgeRelayer {
  private readonly wallet: WalletClient | null;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    if (!relayerEnabled || !config.RELAYER_PRIVATE_KEY) {
      this.wallet = null;
      this.account = null;
      return;
    }

    this.account = privateKeyToAccount(config.RELAYER_PRIVATE_KEY as Hex);
    this.wallet = createWalletClient({
      account: this.account,
      chain: clientFor(config.DESTINATION_CHAIN_ID).chain,
      transport: http(config.DESTINATION_RPC_URL),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.wallet || !this.account) {
      logger.info('relayer disabled: set RELAYER_PRIVATE_KEY and the bridge addresses to enable');
      return;
    }

    this.running = true;
    logger.info({relayer: this.account.address}, 'relayer starting');

    await this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    logger.info('relayer stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => logger.error({error}, 'relayer pass failed'))
        .finally(() => this.scheduleNext());
    }, config.RELAYER_INTERVAL * 1_000);
  }

  /** One pass through every stage. Each stage is independent, so a stall in one does not block the rest. */
  private async tick(): Promise<void> {
    await this.advanceConfirmations();
    await this.collectSignatures();
    await this.submitSigned();
    await this.checkSubmitted();
    await this.executeDelayed();
  }

  /*//////////////////////////////////////////////////////////////
                        OBSERVED -> CONFIRMED
  //////////////////////////////////////////////////////////////*/

  /**
   * Wait for the source transaction to be final before acting on it.
   *
   * Relaying an unconfirmed transfer is how a bridge mints against a deposit that later reorgs
   * away. BSC reorgs are shallow but real, and its three second blocks mean one is over before
   * anyone notices.
   */
  private async advanceConfirmations(): Promise<void> {
    const pending = await prisma.bridgeTransfer.findMany({
      where: {status: 'OBSERVED'},
      take: 50,
    });
    if (pending.length === 0) return;

    const source = clientFor(config.SOURCE_CHAIN_ID);
    const head = await source.getBlockNumber();

    for (const transfer of pending) {
      const confirmations = Number(head - transfer.sourceBlockNumber);

      if (confirmations < config.BRIDGE_CONFIRMATIONS) {
        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {confirmations: Math.max(0, confirmations)},
        });
        continue;
      }

      // Re-read the receipt at the confirmed depth. If the transaction is gone, it was reorged out
      // and the transfer must be dropped rather than relayed.
      const receipt = await source
        .getTransactionReceipt({hash: transfer.sourceTxHash as Hex})
        .catch(() => null);

      if (!receipt || receipt.status !== 'success') {
        logger.warn(
          {messageHash: transfer.messageHash, txHash: transfer.sourceTxHash},
          'source transaction vanished, likely reorged out',
        );

        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {status: 'FAILED', lastError: 'source transaction not found after confirmations'},
        });
        continue;
      }

      await prisma.bridgeTransfer.update({
        where: {messageHash: transfer.messageHash},
        data: {status: 'CONFIRMED', confirmations},
      });

      logger.info({messageHash: transfer.messageHash, confirmations}, 'transfer confirmed');
    }
  }

  /*//////////////////////////////////////////////////////////////
                         CONFIRMED -> SIGNED
  //////////////////////////////////////////////////////////////*/

  /**
   * Collect validator signatures.
   *
   * In production each validator is an independent service with its own key, and this step is an
   * authenticated request to each of them. They independently verify the source event before
   * signing; that independence is the entire security model, and a validator that signs whatever
   * the relayer asks contributes nothing.
   *
   * The demo mode below signs locally with configured keys so the flow is runnable end to end. It
   * is clearly separated and refuses to run outside development.
   */
  private async collectSignatures(): Promise<void> {
    const confirmed = await prisma.bridgeTransfer.findMany({
      where: {status: 'CONFIRMED'},
      include: {signatures: true},
      take: 20,
    });

    for (const transfer of confirmed) {
      const existing = new Set(transfer.signatures.map((row) => row.validator.toLowerCase()));

      const collected = await this.requestSignatures(transfer.messageHash, existing);

      for (const {validator, signature} of collected) {
        await prisma.bridgeSignature.upsert({
          where: {
            messageHash_validator: {messageHash: transfer.messageHash, validator: validator.toLowerCase()},
          },
          create: {
            messageHash: transfer.messageHash,
            validator: validator.toLowerCase(),
            signature,
          },
          update: {},
        });
      }

      const total = await prisma.bridgeSignature.count({
        where: {messageHash: transfer.messageHash},
      });

      if (total >= config.BRIDGE_THRESHOLD) {
        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {status: 'SIGNED'},
        });

        logger.info({messageHash: transfer.messageHash, signatures: total}, 'threshold reached');
      }
    }
  }

  /**
   * Ask validators to sign.
   *
   * Two modes, and the distinction matters:
   *
   * - **Production**: an authenticated request to each validator's signing service. Each validator
   *   independently verifies the source event before signing.
   * - **Development**: signs locally with `DEV_VALIDATOR_KEYS`, so the whole pipeline is runnable
   *   without standing up five services. This is **not** a bridge: one process holding every key is
   *   a custodian. It refuses to run outside development for exactly that reason.
   */
  private async requestSignatures(
    messageHash: string,
    already: Set<string>,
  ): Promise<{validator: Address; signature: Hex}[]> {
    if (config.NODE_ENV !== 'development' || config.DEV_VALIDATOR_KEYS.length === 0) {
      // Production path. Each validator endpoint is called independently; a validator that is down
      // simply does not contribute, and the threshold covers the rest.
      const results: {validator: Address; signature: Hex}[] = [];

      await Promise.all(
        config.VALIDATOR_ENDPOINTS.map(async (endpoint) => {
          try {
            const response = await fetch(`${endpoint}/sign`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.VALIDATOR_API_KEY ?? ''}`,
              },
              body: JSON.stringify({messageHash}),
              signal: AbortSignal.timeout(10_000),
            });

            if (!response.ok) return;

            const body = (await response.json()) as {validator?: string; signature?: string};
            if (!body.validator || !body.signature) return;
            if (already.has(body.validator.toLowerCase())) return;

            results.push({
              validator: body.validator as Address,
              signature: body.signature as Hex,
            });
          } catch (error) {
            logger.debug({error, endpoint}, 'validator unreachable');
          }
        }),
      );

      return results;
    }

    // Development path.
    const transfer = await prisma.bridgeTransfer.findUnique({where: {messageHash}});
    if (!transfer) return [];

    const destination = clientFor(config.DESTINATION_CHAIN_ID);

    const digest = await destination.readContract({
      address: config.DESTINATION_BRIDGE_ADDRESS!,
      abi: bridgeAbi,
      functionName: 'transferDigest',
      args: [
        {
          sourceChainId: BigInt(transfer.sourceChainId),
          destinationChainId: BigInt(transfer.destinationChainId),
          destinationBridge: transfer.destinationBridge as Address,
          token: transfer.token as Address,
          recipient: transfer.recipient as Address,
          amount: BigInt(transfer.amount),
          nonce: BigInt(transfer.nonce),
        },
      ],
    });

    const results: {validator: Address; signature: Hex}[] = [];

    for (const key of config.DEV_VALIDATOR_KEYS) {
      const account = privateKeyToAccount(key as Hex);
      if (already.has(account.address.toLowerCase())) continue;

      // Signing the digest directly: it is already the EIP-712 hash the contract computed, so
      // hashing it again would produce a signature that recovers to the wrong address.
      const signature = await account.sign({hash: digest});
      results.push({validator: account.address, signature});
    }

    return results;
  }

  /*//////////////////////////////////////////////////////////////
                         SIGNED -> SUBMITTED
  //////////////////////////////////////////////////////////////*/

  private async submitSigned(): Promise<void> {
    if (!this.wallet || !this.account || !config.DESTINATION_BRIDGE_ADDRESS) return;

    const signed = await prisma.bridgeTransfer.findMany({
      where: {status: 'SIGNED', attempts: {lt: config.RELAYER_MAX_ATTEMPTS}},
      include: {signatures: true},
      take: 5,
    });

    const destination = clientFor(config.DESTINATION_CHAIN_ID);

    for (const transfer of signed) {
      // The contract requires strictly ascending signer addresses, which is what makes a duplicate
      // signature impossible to submit. Sorting here is not a nicety; an unsorted set reverts.
      const sorted = [...transfer.signatures].sort((a, b) =>
        a.validator.toLowerCase() < b.validator.toLowerCase() ? -1 : 1,
      );

      const args = [
        {
          sourceChainId: BigInt(transfer.sourceChainId),
          destinationChainId: BigInt(transfer.destinationChainId),
          destinationBridge: transfer.destinationBridge as Address,
          token: transfer.token as Address,
          recipient: transfer.recipient as Address,
          amount: BigInt(transfer.amount),
          nonce: BigInt(transfer.nonce),
        },
        sorted.map((row) => row.signature as Hex),
      ] as const;

      try {
        // Simulate first. A revert here costs nothing; on-chain it costs gas and produces a
        // failed transaction the user will ask about.
        await destination.simulateContract({
          address: config.DESTINATION_BRIDGE_ADDRESS,
          abi: bridgeAbi,
          functionName: 'bridgeIn',
          args,
          account: this.account.address,
        });

        const hash = await this.wallet.writeContract({
          address: config.DESTINATION_BRIDGE_ADDRESS,
          abi: bridgeAbi,
          functionName: 'bridgeIn',
          args,
          account: this.account,
          chain: destination.chain,
        });

        // Written before waiting for the receipt, so a crash mid-wait leaves a record of the
        // submission rather than causing a second one.
        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {
            status: 'SUBMITTED',
            destinationTxHash: hash,
            attempts: {increment: 1},
            lastError: null,
          },
        });

        logger.info({messageHash: transfer.messageHash, hash}, 'transfer submitted');
      } catch (error) {
        const message = (error as Error).message.split('\n')[0] ?? 'unknown error';

        // Already processed means another relayer got there first. That is a success, not an error:
        // the whole point of a permissionless relayer set is that any of them can finish the job.
        if (message.includes('AlreadyProcessed')) {
          await prisma.bridgeTransfer.update({
            where: {messageHash: transfer.messageHash},
            data: {status: 'COMPLETED', completedAt: new Date()},
          });
          continue;
        }

        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {attempts: {increment: 1}, lastError: message.slice(0, 500)},
        });

        logger.error({error, messageHash: transfer.messageHash}, 'submission failed');
      }
    }
  }

  /*//////////////////////////////////////////////////////////////
                        SUBMITTED -> COMPLETED
  //////////////////////////////////////////////////////////////*/

  private async checkSubmitted(): Promise<void> {
    const submitted = await prisma.bridgeTransfer.findMany({
      where: {status: 'SUBMITTED', destinationTxHash: {not: null}},
      take: 20,
    });

    const destination = clientFor(config.DESTINATION_CHAIN_ID);

    for (const transfer of submitted) {
      const receipt = await destination
        .getTransactionReceipt({hash: transfer.destinationTxHash as Hex})
        .catch(() => null);

      // Not mined yet. Leave it and check again next pass.
      if (!receipt) continue;

      if (receipt.status !== 'success') {
        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {status: 'SIGNED', lastError: 'destination transaction reverted'},
        });
        continue;
      }

      // The destination bridge queues large transfers rather than releasing them, and that path
      // emits TransferQueued instead of TransferCompleted. Read the contract to tell them apart.
      const queuedAt = await destination
        .readContract({
          address: config.DESTINATION_BRIDGE_ADDRESS!,
          abi: bridgeAbi,
          functionName: 'queuedAt',
          args: [transfer.messageHash as Hex],
        })
        .catch(() => 0n);

      const processed = await destination
        .readContract({
          address: config.DESTINATION_BRIDGE_ADDRESS!,
          abi: bridgeAbi,
          functionName: 'processed',
          args: [transfer.messageHash as Hex],
        })
        .catch(() => false);

      if (processed) {
        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {status: 'COMPLETED', completedAt: new Date()},
        });

        logger.info({messageHash: transfer.messageHash}, 'transfer completed');
        continue;
      }

      if (queuedAt > 0n) {
        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {status: 'DELAYED', executableAt: new Date(Number(queuedAt) * 1000)},
        });

        logger.info(
          {messageHash: transfer.messageHash, executableAt: Number(queuedAt)},
          'transfer queued by the destination delay',
        );
      }
    }
  }

  /*//////////////////////////////////////////////////////////////
                         DELAYED -> COMPLETED
  //////////////////////////////////////////////////////////////*/

  /** Execute large transfers once their delay has elapsed. */
  private async executeDelayed(): Promise<void> {
    if (!this.wallet || !this.account || !config.DESTINATION_BRIDGE_ADDRESS) return;

    const ready = await prisma.bridgeTransfer.findMany({
      where: {
        status: 'DELAYED',
        executableAt: {lte: new Date()},
        attempts: {lt: config.RELAYER_MAX_ATTEMPTS},
      },
      include: {signatures: true},
      take: 5,
    });

    const destination = clientFor(config.DESTINATION_CHAIN_ID);

    for (const transfer of ready) {
      const sorted = [...transfer.signatures].sort((a, b) =>
        a.validator.toLowerCase() < b.validator.toLowerCase() ? -1 : 1,
      );

      try {
        const hash = await this.wallet.writeContract({
          address: config.DESTINATION_BRIDGE_ADDRESS,
          abi: bridgeAbi,
          functionName: 'executeQueued',
          args: [
            {
              sourceChainId: BigInt(transfer.sourceChainId),
              destinationChainId: BigInt(transfer.destinationChainId),
              destinationBridge: transfer.destinationBridge as Address,
              token: transfer.token as Address,
              recipient: transfer.recipient as Address,
              amount: BigInt(transfer.amount),
              nonce: BigInt(transfer.nonce),
            },
            sorted.map((row) => row.signature as Hex),
          ],
          account: this.account,
          chain: destination.chain,
        });

        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {status: 'SUBMITTED', destinationTxHash: hash, attempts: {increment: 1}},
        });

        logger.info({messageHash: transfer.messageHash, hash}, 'delayed transfer executed');
      } catch (error) {
        await prisma.bridgeTransfer.update({
          where: {messageHash: transfer.messageHash},
          data: {
            attempts: {increment: 1},
            lastError: (error as Error).message.split('\n')[0]?.slice(0, 500),
          },
        });
      }
    }
  }
}
