import 'dotenv/config';
import {z} from 'zod';

/**
 * Treat an empty variable as absent.
 *
 * An unset variable in a .env file arrives as an empty string, not as undefined, so `.optional()`
 * on its own rejects the shipped .env.example and refuses to start over settings the operator
 * deliberately left blank. Every optional value below goes through this.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}


const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((value) => value.toLowerCase() as `0x${string}`);

const optionalAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`)
  .optional();

/**
 * Environment is validated once at boot. A wrong contract address or a missing RPC should crash the
 * process immediately with a readable message, not surface later as a confusing runtime failure.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PORT: z.coerce.number().int().positive().default(4002),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim())),

  DATABASE_URL: z.string().url(),

  /** 56 = BSC mainnet, 97 = BSC testnet, 204 = opBNB. */
  CHAIN_ID: z.coerce.number().int().positive().default(97),
  RPC_URL: z.string().url(),

  REWARD_TOKEN_ADDRESS: addressSchema,
  MASTERCHEF_ADDRESS: addressSchema,
  ORACLE_ADDRESS: optionalAddress,
  VAULT_ADDRESS: optionalAddress,
  ROUTER_ADDRESS: addressSchema,

  /** Blocks below (head - CONFIRMATIONS) are final; above it, logs are re-scanned every pass. */
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(15),
  INDEXER_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(2_000),
  /** BSC produces a block roughly every 3 seconds, so polling faster than that is wasted work. */
  INDEXER_POLL_INTERVAL: z.coerce.number().int().positive().default(6),
  DEPLOY_BLOCK: z.coerce.bigint().default(0n),

  /** How often to snapshot pool TVL and APR, in seconds. */
  SNAPSHOT_INTERVAL: z.coerce.number().int().positive().default(900),

  /*//////////////////////////////////////////////////////////////
                                KEEPER
  //////////////////////////////////////////////////////////////*/

  /** Set to enable the compound keeper. Without it the keeper stays off. */
  // An unset variable in a .env file arrives as an empty string, so `.optional()` alone would
  // reject the shipped .env.example and refuse to start over a key that is meant to be absent.
  KEEPER_PRIVATE_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key')
      .optional(),
  ),

  /** Seconds between keeper evaluations. */
  KEEPER_INTERVAL: z.coerce.number().int().positive().default(300),

  /**
   * How much more the bounty must be worth than the gas before the keeper acts, in basis points.
   *
   * 12,000 means "the bounty must be worth at least 1.2x the gas". A keeper that compounds at
   * break-even loses money to price movement between estimate and execution.
   */
  KEEPER_MIN_PROFIT_BPS: z.coerce.number().int().min(10_000).default(12_000),

  /** Refuse to send if the gas price exceeds this, in gwei. A spike is worth waiting out. */
  KEEPER_MAX_GAS_GWEI: z.coerce.number().positive().default(10),

  /** Seconds a compound transaction stays valid, passed as the swap deadline. */
  KEEPER_DEADLINE_SECONDS: z.coerce.number().int().positive().default(120),

  /** USD price of the reward token, when no on-chain feed exists for it. */
  REWARD_TOKEN_PRICE_USD: optional(z.coerce.number().nonnegative()),
  /**
   * Whether this process runs the indexer.
   *
   * Off lets the API serve seeded or already-indexed data without a chain connection, and lets the
   * indexer run as its own process (`pnpm indexer`) without the API double-indexing behind it.
   */
  INDEXER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;

/** Whether the keeper has everything it needs to run. */
export const keeperEnabled = Boolean(config.KEEPER_PRIVATE_KEY && config.VAULT_ADDRESS);
