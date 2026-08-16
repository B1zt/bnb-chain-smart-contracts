import {createWalletClient, formatEther, http, parseGwei, type WalletClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {vaultAbi} from '../chain/abis.js';
import {publicClient} from '../chain/client.js';
import {config, keeperEnabled} from '../config.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';
import {getTokenInfo, getTokenPriceUsd, valueUsd} from '../pricing.js';

const WAD = 10n ** 18n;

type Decision =
  | {act: true; bounty: bigint; bountyUsd: bigint; gasCostUsd: bigint; gasEstimate: bigint; gasPrice: bigint}
  | {act: false; reason: string; bounty: bigint; bountyUsd: bigint | null; gasCostUsd: bigint | null; gasEstimate: bigint; gasPrice: bigint};

/**
 * Compound keeper.
 *
 * The vault's `compound` is permissionless and pays a bounty, so anyone can call it. This is the
 * bot that does, and the whole job is one decision: **is the bounty worth more than the gas?**
 *
 * Getting that decision wrong in either direction is expensive:
 *
 * - Compound too eagerly and the keeper burns more in gas than it earns. A bot that quietly loses
 *   money for weeks is worse than no bot, because nobody notices until the wallet is empty.
 * - Compound too rarely and the vault's yield suffers, which is the thing the vault exists for.
 *
 * So every evaluation is written to `CompoundRun` with the numbers behind it, whether it acted or
 * not. The decisions are auditable after the fact instead of being invisible.
 *
 * Three guards beyond profitability:
 *
 * 1. **Simulation before submission.** `simulateContract` runs the call against current state and
 *    reverts locally if it would revert on-chain, so a failing compound never costs gas.
 * 2. **A gas price ceiling.** BSC gas spikes; the rewards keep accruing, so waiting is free.
 * 3. **A deadline on the swap.** A transaction stuck in the mempool must not execute an hour later
 *    at a price nobody agreed to.
 */
export class CompoundKeeper {
  private readonly wallet: WalletClient | null;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    if (!keeperEnabled || !config.KEEPER_PRIVATE_KEY) {
      this.wallet = null;
      this.account = null;
      return;
    }

    this.account = privateKeyToAccount(config.KEEPER_PRIVATE_KEY as `0x${string}`);
    this.wallet = createWalletClient({
      account: this.account,
      chain: publicClient.chain,
      transport: http(config.RPC_URL),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.wallet || !this.account || !config.VAULT_ADDRESS) {
      logger.info('keeper disabled: set KEEPER_PRIVATE_KEY and VAULT_ADDRESS to enable');
      return;
    }

    this.running = true;

    const balance = await publicClient.getBalance({address: this.account.address});
    logger.info(
      {
        keeper: this.account.address,
        balance: formatEther(balance),
        interval: config.KEEPER_INTERVAL,
        minProfitBps: config.KEEPER_MIN_PROFIT_BPS,
      },
      'keeper starting',
    );

    if (balance === 0n) {
      logger.warn('keeper wallet has no native balance and cannot pay gas');
    }

    await this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    logger.info('keeper stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => logger.error({error}, 'keeper pass failed'))
        .finally(() => this.scheduleNext());
    }, config.KEEPER_INTERVAL * 1_000);
  }

  private async tick(): Promise<void> {
    if (!this.wallet || !this.account || !config.VAULT_ADDRESS) return;

    const decision = await this.evaluate();

    if (!decision.act) {
      logger.debug(
        {reason: decision.reason, bounty: decision.bounty.toString()},
        'skipping compound',
      );

      // Only unprofitable skips are recorded. Writing a row every time there is simply nothing to
      // harvest would bury the interesting decisions under noise.
      if (decision.reason === 'unprofitable') {
        await prisma.compoundRun.create({
          data: {
            outcome: 'SKIPPED_UNPROFITABLE',
            pendingReward: decision.bounty.toString(),
            expectedBounty: decision.bounty.toString(),
            estimatedGasWei: (decision.gasEstimate * decision.gasPrice).toString(),
            bountyUsd: decision.bountyUsd?.toString() ?? null,
            gasCostUsd: decision.gasCostUsd?.toString() ?? null,
          },
        });
      }

      return;
    }

    await this.execute(decision);
  }

  /** Decide whether compounding is worth it right now. */
  private async evaluate(): Promise<Decision> {
    const vault = config.VAULT_ADDRESS!;

    const [bounty, gasPrice] = await Promise.all([
      publicClient.readContract({address: vault, abi: vaultAbi, functionName: 'callerBounty'}),
      publicClient.getGasPrice(),
    ]);

    const empty = {bounty, bountyUsd: null, gasCostUsd: null, gasEstimate: 0n, gasPrice};

    if (bounty === 0n) {
      return {act: false, reason: 'nothing to harvest', ...empty};
    }

    // A gas spike is worth waiting out: the rewards keep accruing either way.
    const maxGasPrice = parseGwei(String(config.KEEPER_MAX_GAS_GWEI));
    if (gasPrice > maxGasPrice) {
      return {act: false, reason: 'gas price above ceiling', ...empty, gasPrice};
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + config.KEEPER_DEADLINE_SECONDS);

    // Simulate first. This runs the call against current state and throws if it would revert, so a
    // compound that would fail (slippage bound, nothing to harvest, paused) never costs gas.
    let gasEstimate: bigint;
    try {
      await publicClient.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'compound',
        args: [deadline],
        account: this.account!.address,
      });

      gasEstimate = await publicClient.estimateContractGas({
        address: vault,
        abi: vaultAbi,
        functionName: 'compound',
        args: [deadline],
        account: this.account!.address,
      });
    } catch (error) {
      return {
        act: false,
        reason: `simulation reverted: ${(error as Error).message.split('\n')[0]}`,
        ...empty,
      };
    }

    // Value both sides in USD so they are actually comparable. Comparing a reward-token amount to a
    // gas cost in BNB directly is the mistake that makes a keeper lose money on a token that fell.
    const rewardPrice = await getTokenPriceUsd(config.REWARD_TOKEN_ADDRESS);
    const nativePrice = await this.getNativePriceUsd();

    if (rewardPrice === null || nativePrice === null) {
      // Without prices there is no way to judge profitability. Refusing is the safe default: a
      // keeper that compounds blind is exactly the failure mode this class exists to avoid.
      return {
        act: false,
        reason: 'no price available to judge profitability',
        bounty,
        bountyUsd: null,
        gasCostUsd: null,
        gasEstimate,
        gasPrice,
      };
    }

    const rewardInfo = await getTokenInfo(config.REWARD_TOKEN_ADDRESS);
    const bountyUsd = valueUsd(bounty, rewardInfo.decimals, rewardPrice);

    // 20% headroom on the gas estimate: the actual cost can exceed the estimate when state moves
    // between simulation and inclusion.
    const gasCostWei = (gasEstimate * gasPrice * 120n) / 100n;
    const gasCostUsd = (gasCostWei * nativePrice) / WAD;

    const requiredUsd = (gasCostUsd * BigInt(config.KEEPER_MIN_PROFIT_BPS)) / 10_000n;

    if (bountyUsd < requiredUsd) {
      return {
        act: false,
        reason: 'unprofitable',
        bounty,
        bountyUsd,
        gasCostUsd,
        gasEstimate,
        gasPrice,
      };
    }

    return {act: true, bounty, bountyUsd, gasCostUsd, gasEstimate, gasPrice};
  }

  private async execute(decision: Extract<Decision, {act: true}>): Promise<void> {
    const vault = config.VAULT_ADDRESS!;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + config.KEEPER_DEADLINE_SECONDS);

    try {
      const hash = await this.wallet!.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'compound',
        args: [deadline],
        account: this.account!,
        chain: publicClient.chain,
        // Headroom over the estimate, so a small state change between estimate and inclusion does
        // not waste the transaction on an out-of-gas revert.
        gas: (decision.gasEstimate * 130n) / 100n,
      });

      logger.info({hash, bountyUsd: decision.bountyUsd.toString()}, 'compound submitted');

      const receipt = await publicClient.waitForTransactionReceipt({hash, timeout: 120_000});

      await prisma.compoundRun.create({
        data: {
          txHash: hash,
          outcome: receipt.status === 'success' ? 'SUCCESS' : 'FAILED',
          pendingReward: decision.bounty.toString(),
          expectedBounty: decision.bounty.toString(),
          estimatedGasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
          bountyUsd: decision.bountyUsd.toString(),
          gasCostUsd: decision.gasCostUsd.toString(),
          error: receipt.status === 'success' ? null : 'transaction reverted',
        },
      });

      logger.info(
        {hash, status: receipt.status, gasUsed: receipt.gasUsed.toString()},
        'compound settled',
      );
    } catch (error) {
      logger.error({error}, 'compound failed');

      await prisma.compoundRun.create({
        data: {
          outcome: 'FAILED',
          pendingReward: decision.bounty.toString(),
          expectedBounty: decision.bounty.toString(),
          estimatedGasWei: (decision.gasEstimate * decision.gasPrice).toString(),
          bountyUsd: decision.bountyUsd.toString(),
          gasCostUsd: decision.gasCostUsd.toString(),
          error: (error as Error).message.slice(0, 500),
        },
      });
    }
  }

  /**
   * USD price of the chain's native token, for costing gas.
   *
   * On BSC this is BNB, and the oracle is configured with the wrapped version, so the wrapped
   * address is what gets queried.
   */
  private async getNativePriceUsd(): Promise<bigint | null> {
    const wrappedNative = WRAPPED_NATIVE[config.CHAIN_ID];
    if (!wrappedNative) return null;

    return getTokenPriceUsd(wrappedNative);
  }
}

/** Wrapped native token per chain, for gas costing. */
const WRAPPED_NATIVE: Record<number, `0x${string}` | undefined> = {
  56: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB, BSC mainnet
  97: '0xae13d989dac2f0debff460ac112a837c89baa7cd', // WBNB, BSC testnet
  204: '0x4200000000000000000000000000000000000006', // WBNB, opBNB
};
