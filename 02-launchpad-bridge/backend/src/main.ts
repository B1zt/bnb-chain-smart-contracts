import {config} from './config.js';
import {Indexer} from './indexer/indexer.js';
import {logger} from './lib/logger.js';
import {prisma} from './lib/prisma.js';
import {BridgeRelayer} from './relayer/relayer.js';
import {buildServer} from './server.js';

/**
 * Single-process entrypoint: API, indexer and relayer together.
 *
 * Fine for a demo. In production run the relayer separately (`pnpm relayer`): it holds a signing
 * key, and keeping that out of the public HTTP server's process limits what an API vulnerability
 * can reach.
 */
async function main(): Promise<void> {
  const app = await buildServer();
  const indexer = new Indexer();
  const relayer = new BridgeRelayer();

  await app.listen({port: config.PORT, host: config.HOST});
  logger.info({port: config.PORT, chainId: config.CHAIN_ID}, 'api listening');

  await indexer.start();
  await relayer.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({signal}, 'shutting down');
    relayer.stop();
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
