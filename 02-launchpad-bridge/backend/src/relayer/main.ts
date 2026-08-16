import {Indexer} from '../indexer/indexer.js';
import {logger} from '../lib/logger.js';
import {prisma} from '../lib/prisma.js';
import {BridgeRelayer} from './relayer.js';

/**
 * Standalone relayer entrypoint.
 *
 * Runs the indexer alongside it, because the relayer has nothing to work from unless something is
 * recording outbound transfers. Preferred over the combined process in production: the relayer
 * holds a signing key, and isolating it from the public API keeps a web vulnerability away from it.
 */
async function main(): Promise<void> {
  const indexer = new Indexer();
  const relayer = new BridgeRelayer();

  await indexer.start();
  await relayer.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({signal}, 'shutting down relayer');
    relayer.stop();
    indexer.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({error}, 'relayer failed to start');
  process.exit(1);
});
