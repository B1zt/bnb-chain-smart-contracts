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
    /*
     * Two things break the default JSON encoding of a log line.
     *
     * Block numbers, token ids and slots are bigints, which `JSON.stringify` throws on outright.
     * And Fastify's request logs carry the raw request and response, which reference each other,
     * so a naive round trip throws "Converting circular structure to JSON" on the first HTTP
     * request the server handles. Both have to be handled or the logger takes the process down.
     */
    log: (object) => {
      const seen = new WeakSet<object>();

      return JSON.parse(
        JSON.stringify(object, (_key, value: unknown) => {
          if (typeof value === 'bigint') return value.toString();

          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[circular]';
            seen.add(value);
          }

          return value;
        }),
      ) as Record<string, unknown>;
    },
  },
};

/** Standalone logger for the indexer and other non-HTTP entrypoints. */
export const logger = pino(loggerOptions);
