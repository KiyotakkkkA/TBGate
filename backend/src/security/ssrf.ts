import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DestinationError } from '../lib/errors.js';

export interface SsrfPolicy {
  /** Docker service-name routing requires private targets, so this defaults to true. */
  allowPrivateNetworks: boolean;
}

/** Structural checks that never touch the network. */
export function assertSafeDestinationUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DestinationError('DESTINATION_URL_REJECTED', 'Destination URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DestinationError(
      'DESTINATION_URL_REJECTED',
      `Scheme "${url.protocol}" is not allowed; use http:// or https://`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new DestinationError(
      'DESTINATION_URL_REJECTED',
      'Credentials embedded in the destination URL are not allowed; use a custom header instead',
    );
  }
  if (url.hostname === '') {
    throw new DestinationError('DESTINATION_URL_REJECTED', 'Destination URL has no host');
  }
  return url;
}

function ipv4ToParts(address: string): number[] | null {
  const parts = address.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const parts = ipv4ToParts(address);
    if (!parts) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this network"
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (family === 6) {
    const normalized = address.toLowerCase().split('%')[0] ?? '';
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(normalized)) return true; // unique local fc00::/7
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      if (isIP(mapped) === 4) return isPrivateAddress(mapped);
    }
    return false;
  }

  return false;
}

/**
 * Full destination check. When private networks are disabled the hostname is resolved and
 * every returned address must be public, which blocks loopback/link-local/RFC1918 targets
 * (including cloud metadata endpoints) even behind a public-looking DNS name.
 *
 * Note: this is a check-then-connect design, so it does not defeat a determined DNS
 * rebinding attack. Only administrators can configure destinations - see docs/SECURITY.md.
 */
export async function assertDestinationAllowed(rawUrl: string, policy: SsrfPolicy): Promise<URL> {
  const url = assertSafeDestinationUrl(rawUrl);
  if (policy.allowPrivateNetworks) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];

  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      const resolved = await lookup(host, { all: true });
      addresses = resolved.map((entry) => entry.address);
    } catch {
      throw new DestinationError(
        'DESTINATION_UNREACHABLE',
        `Could not resolve destination host "${host}"`,
      );
    }
  }

  if (addresses.length === 0) {
    throw new DestinationError(
      'DESTINATION_UNREACHABLE',
      `Destination host "${host}" resolved to no addresses`,
    );
  }

  const blocked = addresses.filter((address) => isPrivateAddress(address));
  if (blocked.length > 0) {
    throw new DestinationError(
      'DESTINATION_URL_REJECTED',
      `Destination host "${host}" resolves to a private or loopback address. ` +
        'Set DESTINATION_ALLOW_PRIVATE_NETWORKS=true to allow internal targets.',
    );
  }

  return url;
}
