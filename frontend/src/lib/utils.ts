import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Compact relative time for activity columns: "12s ago", "3h ago", "5d ago". */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'never';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'never';

  const deltaSeconds = Math.round((Date.now() - timestamp) / 1000);
  const future = deltaSeconds < 0;
  const seconds = Math.abs(deltaSeconds);

  let text: string;
  if (seconds < 10) text = 'just now';
  else if (seconds < 60) text = `${seconds}s`;
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)}m`;
  else if (seconds < 86400) text = `${Math.floor(seconds / 3600)}h`;
  else if (seconds < 2592000) text = `${Math.floor(seconds / 86400)}d`;
  else text = new Date(timestamp).toLocaleDateString();

  if (text === 'just now') return text;
  return future ? `in ${text}` : `${text} ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Turns `message`/`callback_query` into `Message` / `Callback query` for display. */
export function humanizeUpdateType(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
