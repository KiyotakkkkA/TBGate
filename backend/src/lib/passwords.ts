import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id (the library default) with OWASP-recommended parameters for interactive
 * logins: 19 MiB memory, 2 iterations, 1 degree of parallelism.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, OPTIONS);
  } catch {
    // Corrupt or foreign hash format - treat as a failed login, never as an error.
    return false;
  }
}
