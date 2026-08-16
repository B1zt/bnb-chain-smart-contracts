import {CompoundKeeper} from './keeper.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';

/**
 * Standalone keeper entrypoint.
 *
 * Preferred over the combined process in production: the keeper holds a private key, and isolating
 * it from the public HTTP server keeps an API vulnerability from reaching the signing key.
 */
async function main(): Promise<void> {
  const keeper = new CompoundKeeper();
  await keeper.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({signal}, 'shutting down keeper');
    keeper.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({error}, 'keeper failed to start');
  process.exit(1);
});
