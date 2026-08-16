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

const optionalAddress = optional(addressSchema);

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Environment, validated once at boot.
 *
 * The bridge half needs two of everything, because a relayer by definition spans two chains. They
 * are named source and destination rather than "chain A and B" so a misconfiguration reads as an
 * obvious mistake rather than a plausible one.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PORT: z.coerce.number().int().positive().default(4003),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform(csv),

  DATABASE_URL: z.string().url(),

  /* ---------------------------------------------------------- launchpad --- */

  CHAIN_ID: z.coerce.number().int().positive().default(97),
  RPC_URL: z.string().url(),

  FACTORY_ADDRESS: addressSchema,
  LOCKER_ADDRESS: addressSchema,
  PRICE_FEED_ADDRESS: optionalAddress,

  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(15),
  INDEXER_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(2_000),
  INDEXER_POLL_INTERVAL: z.coerce.number().int().positive().default(6),
  DEPLOY_BLOCK: z.coerce.bigint().default(0n),

  /**
   * Shared secret for the tier-upload endpoint.
   *
   * Publishing a Merkle root decides who gets an allocation, so that route is not open.
   */
  /**
   * An unset variable in a .env file arrives as an empty string, not as undefined, so `.optional()`
   * alone would reject the shipped .env.example and fail startup with a length complaint about a
   * key the operator never set. Empty is normalised to absent first.
   */
  ADMIN_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(16).optional(),
  ),

  /* ------------------------------------------------------------- bridge --- */

  SOURCE_CHAIN_ID: z.coerce.number().int().positive().default(97),
  SOURCE_RPC_URL: optional(z.string().url()),
  SOURCE_BRIDGE_ADDRESS: optionalAddress,

  DESTINATION_CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  DESTINATION_RPC_URL: optional(z.string().url()),
  DESTINATION_BRIDGE_ADDRESS: optionalAddress,

  /**
   * Confirmations before a source transfer is acted on.
   *
   * Relaying an unconfirmed transfer is how a bridge mints against a deposit that later reorgs
   * away. Higher than the indexer's own depth, because the cost of being wrong is much larger.
   */
  BRIDGE_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(20),

  /** Validator signatures required by the destination bridge. Must match its on-chain threshold. */
  BRIDGE_THRESHOLD: z.coerce.number().int().positive().default(3),

  // An unset variable in a .env file arrives as an empty string, so `.optional()` alone would
  // reject the shipped .env.example and refuse to start over a key that is meant to be absent.
  RELAYER_PRIVATE_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key')
      .optional(),
  ),

  RELAYER_INTERVAL: z.coerce.number().int().positive().default(15),

  /** Give up on a transfer after this many failed submissions, rather than burning gas forever. */
  RELAYER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /** Validator signing services, one URL each. */
  VALIDATOR_ENDPOINTS: z.string().default('').transform(csv),
  VALIDATOR_API_KEY: optional(z.string()),

  /**
   * Local validator keys, for running the whole pipeline in development.
   *
   * One process holding every validator key is a custodian, not a bridge. The relayer refuses to
   * use these outside NODE_ENV=development for exactly that reason.
   */
  DEV_VALIDATOR_KEYS: z
    .string()
    .default('')
    .transform((value) => csv(value).filter((key) => /^0x[0-9a-fA-F]{64}$/.test(key))),
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

/** Whether the relayer has everything it needs to run. */
export const relayerEnabled = Boolean(
  config.RELAYER_PRIVATE_KEY &&
    config.SOURCE_BRIDGE_ADDRESS &&
    config.DESTINATION_BRIDGE_ADDRESS &&
    config.SOURCE_RPC_URL &&
    config.DESTINATION_RPC_URL,
);
