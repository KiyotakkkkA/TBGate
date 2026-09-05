import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-card border border-border-base bg-surface shadow-sm',
        padded && 'p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-text">{title}</h1>
        {description ? <p className="mt-1 text-sm text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Shown when a collection is legitimately empty - never for an error or a loading state. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-3 rounded-full bg-bg-subtle p-3">
        <Icon className="h-5 w-5 text-text-faint" aria-hidden />
      </div>
      <p className="text-sm font-medium text-text">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-xs text-text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded bg-bg-subtle', className)} aria-hidden>
      <div className="absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-black/5 to-transparent animate-[shimmer_1.6s_infinite] dark:via-white/5" />
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    default: 'text-text',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <Card className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-text-muted">{label}</p>
        <p className={cn('mt-1.5 text-2xl font-semibold tabular-nums tracking-tight', toneClass)}>
          {value}
        </p>
        {hint ? <p className="mt-1 truncate text-xs text-text-faint">{hint}</p> : null}
      </div>
      {Icon ? (
        <div className="rounded-lg bg-bg-subtle p-2">
          <Icon className="h-4 w-4 text-text-faint" aria-hidden />
        </div>
      ) : null}
    </Card>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  requestId,
  action,
}: {
  title?: string;
  message: string;
  requestId?: string | null;
  action?: ReactNode;
}) {
  return (
    <Card className="border-danger/30 bg-danger-subtle/40">
      <p className="text-sm font-medium text-text">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{message}</p>
      {requestId ? (
        <p className="mt-2 font-mono text-[11px] text-text-faint">Request ID: {requestId}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </Card>
  );
}
