import {config} from './config.js';
import {Indexer} from './indexer/indexer.js';
import {CompoundKeeper} from './keeper/keeper.js';
import {logger} from './lib/logger.js';
import {prisma} from './lib/prisma.js';
import {buildServer} from './server.js';

/**
 * Single-process entrypoint: API, indexer and keeper together.
 *
 * Fine for a demo. In production the keeper should run separately (`pnpm keeper`): it holds a
 * private key, and keeping that in the same process as a public HTTP server widens the blast radius
 * of any API vulnerability to "attacker can spend the keeper's gas budget".
 */
async function main(): Promise<void> {
  const app = await buildServer();
  const indexer = new Indexer();
  const keeper = new CompoundKeeper();

  await app.listen({port: config.PORT, host: config.HOST});
  logger.info({port: config.PORT, chainId: config.CHAIN_ID}, 'api listening');

  await indexer.start();
  await keeper.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({signal}, 'shutting down');
    keeper.stop();
    indexer.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({error}, 'failed to start');
  process.exit(1);
});
