import { pino, type Logger } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Structured logging. Secret-bearing fields are redacted at the logger level so that
 * an accidental `log.info({ bot })` can never print a token.
 */
export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'LOG_PRETTY' | 'APP_NAME'>): Logger {
  const options = buildOptions(env);
  if (!env.LOG_PRETTY) return pino(options);

  try {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,app' },
      },
    });
  } catch {
    // pino-pretty is a development dependency and is absent from the production image.
    // A logging preference must never prevent the service from starting.
    process.stderr.write(
      'LOG_PRETTY=true was requested but pino-pretty is not installed; falling back to JSON logs.\n',
    );
    return pino(options);
  }
}

function buildOptions(env: Pick<Env, 'LOG_LEVEL' | 'LOG_PRETTY' | 'APP_NAME'>) {
  return {
    level: env.LOG_LEVEL,
    base: { app: env.APP_NAME },
    redact: {
      paths: [
        'token',
        '*.token',
        '*.*.token',
        'password',
        '*.password',
        'encryptedToken',
        '*.encryptedToken',
        'webhookSecret',
        '*.webhookSecret',
        'signingSecret',
        '*.signingSecret',
        'encryptedSigningSecret',
        '*.encryptedSigningSecret',
        'apiKey',
        '*.apiKey',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["x-telegram-bot-api-secret-token"]',
      ],
      censor: '[REDACTED]',
    },
  };
}

export type { Logger };
