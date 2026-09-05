import type { SettingsDto } from '@tg-gateway/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Eraser, KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, useToast } from '@/components/ui/feedback';
import { Button } from '@/components/ui/primitives';
import { Card, CardHeader, ErrorState, PageHeader, Skeleton } from '@/components/ui/surfaces';
import { useSession } from '@/hooks/useSession';
import { ApiError, api } from '@/lib/api';
import { formatUptime } from '@/lib/utils';

export function SettingsPage() {
  const toast = useToast();
  const { isAdmin } = useSession();

  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsDto>('/api/v1/settings'),
  });

  const cleanup = useMutation({
    mutationFn: () =>
      api.post<{ events: number; deliveries: number; sessions: number }>(
        '/api/v1/settings/cleanup',
      ),
    onSuccess: (result) => {
      toast.success(
        'Cleanup finished',
        `${result.events} events, ${result.deliveries} deliveries and ${result.sessions} sessions removed.`,
      );
    },
    onError: (caught) => {
      toast.error('Cleanup failed', caught instanceof ApiError ? caught.message : undefined);
    },
  });

  if (error) {
    return (
      <>
        <PageHeader title="Settings" />
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load settings.'}
          requestId={error instanceof ApiError ? error.requestId : null}
        />
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Runtime configuration of this instance. Values come from the environment and change on restart."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Application" />
          <dl className="mt-3 space-y-2.5">
            <Row label="Name" value={data.appName} />
            <Row label="Version" value={data.version} />
            <Row
              label="Environment"
              value={
                <Badge tone={data.nodeEnv === 'production' ? 'success' : 'warning'}>
                  {data.nodeEnv}
                </Badge>
              }
            />
            <Row label="Uptime" value={formatUptime(data.uptimeSeconds)} />
            <Row
              label="Public base URL"
              value={<code className="font-mono text-xs break-all">{data.publicBaseUrl}</code>}
            />
            <Row
              label="Webhook path"
              value={<code className="font-mono text-xs">{data.webhookPath}/:botId</code>}
            />
            <Row
              label="Trust proxy headers"
              value={
                <Badge tone={data.trustProxy ? 'success' : 'neutral'}>
                  {String(data.trustProxy)}
                </Badge>
              }
            />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Storage" />
          <dl className="mt-3 space-y-2.5">
            <Row label="Driver" value={data.database.driver} />
            <Row
              label="Location"
              value={<code className="font-mono text-xs break-all">{data.database.path}</code>}
            />
            <Row label="Event retention" value={describeDays(data.retention.eventDays)} />
            <Row label="Delivery retention" value={describeDays(data.retention.deliveryDays)} />
            <Row label="Cleanup interval" value={`Every ${data.retention.cleanupIntervalHours}h`} />
          </dl>
          {isAdmin ? (
            <div className="mt-4 border-t border-border-base pt-3">
              <Button
                variant="outline"
                loading={cleanup.isPending}
                onClick={() => cleanup.mutate()}
              >
                <Eraser className="h-3.5 w-3.5" aria-hidden />
                Run cleanup now
              </Button>
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader title="Delivery worker" />
          <dl className="mt-3 space-y-2.5">
            <Row
              label="Worker"
              value={
                <Badge tone={data.worker.enabled ? 'success' : 'neutral'}>
                  {data.worker.enabled ? 'running' : 'disabled'}
                </Badge>
              }
            />
            <Row label="Concurrency" value={data.worker.concurrency} />
            <Row label="Request timeout" value={`${data.worker.timeoutMs} ms`} />
            <Row label="Max attempts" value={data.worker.maxAttempts} />
            <Row
              label="Retry schedule"
              value={
                <span className="flex flex-wrap justify-end gap-1">
                  {data.worker.retryDelaysMs.map((delay, index) => (
                    <Badge key={index}>{formatDelay(delay)}</Badge>
                  ))}
                </span>
              }
            />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Security" />
          <dl className="mt-3 space-y-2.5">
            <Row
              label="Secure cookies"
              value={
                <Badge tone={data.security.cookieSecure ? 'success' : 'warning'}>
                  {String(data.security.cookieSecure)}
                </Badge>
              }
            />
            <Row label="Cookie SameSite" value={data.security.cookieSameSite} />
            <Row label="Session lifetime" value={`${data.security.sessionTtlHours}h`} />
            <Row
              label="Private destinations"
              value={
                <Badge tone={data.security.allowPrivateDestinations ? 'warning' : 'success'}>
                  {data.security.allowPrivateDestinations ? 'allowed' : 'blocked'}
                </Badge>
              }
            />
            <Row
              label="API rate limiting"
              value={
                <Badge tone={data.security.rateLimitEnabled ? 'success' : 'warning'}>
                  {data.security.rateLimitEnabled ? 'enabled' : 'disabled'}
                </Badge>
              }
            />
            <Row
              label="Telegram API"
              value={<code className="font-mono text-xs">{data.telegramApiBaseUrl}</code>}
            />
          </dl>
          <p className="mt-4 border-t border-border-base pt-3 text-xs text-text-muted">
            Bot tokens and signing secrets are encrypted with AES-256-GCM using{' '}
            <code className="font-mono">APP_ENCRYPTION_KEY</code>, which is never stored in the
            database.{' '}
            <Link
              to="/admin/api-keys"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              <KeyRound className="h-3 w-3" aria-hidden />
              Manage API keys
            </Link>
          </p>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <dt className="shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-text">{value}</dd>
    </div>
  );
}

function describeDays(days: number): string {
  return days === 0 ? 'Kept forever' : `${days} days`;
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${ms / 1000}s`;
  return `${ms / 60_000}m`;
}
