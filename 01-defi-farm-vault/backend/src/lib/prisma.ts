import {PrismaClient} from '@prisma/client';
import {config} from '../config.js';

/**
 * Single Prisma client for the process.
 *
 * Cached on `globalThis` so `tsx watch` reloads reuse the existing pool instead of opening a new
 * one on every file save, which otherwise exhausts Postgres connections within a few minutes of
 * development.
 */
const globalForPrisma = globalThis as unknown as {prisma?: PrismaClient};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (config.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * JSON cannot represent a bigint, and Prisma returns block numbers as bigint. Rather than convert
 * at every call site, teach the serialiser to emit them as decimal strings, which is the same
 * representation used for uint256 values everywhere else in the API.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function toJSON(): string {
  return this.toString();
};
