#!/usr/bin/env node
import { randomBytes } from 'node:crypto';

const encryptionKey = randomBytes(32).toString('hex');
const sessionSecret = randomBytes(48).toString('base64');

process.stdout.write(
  [
    '# Copy these into your .env file:',
    '',
    `APP_ENCRYPTION_KEY=${encryptionKey}`,
    `SESSION_SECRET=${sessionSecret}`,
    '',
    '# APP_ENCRYPTION_KEY decrypts every stored bot token. Back it up somewhere safe:',
    '# if you lose it, all stored tokens and signing secrets must be re-entered.',
    '',
  ].join('\n'),
);
