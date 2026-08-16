import pino, {type LoggerOptions} from 'pino';
import {config} from '../config.js';

/**
 * Shared pino configuration.
 *
 * Fastify builds its own logger from these options rather than being handed an instance. Passing an
 * instance works but ties the app's inferred type to pino's generics, which drift between pino and
 * fastify releases and produce type errors that have nothing to do with this codebase.
 */
export const loggerOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname'},
        },
      }
    : {}),
  formatters: {
    // Block numbers and token ids are bigints, and JSON.stringify throws on those by default.
    log: (object) =>
      JSON.parse(
        JSON.stringify(object, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ) as Record<string, unknown>,
  },
};

/** Standalone logger for the indexer and other non-HTTP entrypoints. */
export const logger = pino(loggerOptions);
