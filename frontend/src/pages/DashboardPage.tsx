import type { DashboardStatsDto } from '@tg-gateway/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Database,
  Radio,
  Server,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/ui/feedback';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatTile,
} from '@/components/ui/surfaces';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { ApiError, api } from '@/lib/api';
import { formatNumber, formatPercent, formatRelative, formatUptime } from '@/lib/utils';

export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardStatsDto>('/api/v1/dashboard'),
    refetchInterval: 15_000,
  });

  if (error) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load statistics.'}
          requestId={error instanceof ApiError ? error.requestId : null}
        />
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <PageHeader title="Dashboard" description="Traffic and health at a glance" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-23" />
          ))}
        </div>
        <Skeleton className="mt-4 h-64" />
      </>
    );
  }

  const successTone =
    data.successRate === null
      ? 'default'
      : data.successRate >= 0.95
        ? 'success'
        : data.successRate >= 0.8
          ? 'warning'
          : 'danger';

  return (
    <>
      <PageHeader title="Dashboard" description="Traffic and health at a glance" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Bots"
          value={formatNumber(data.bots.total)}
          hint={`${data.bots.active} active`}
          icon={Bot}
        />
        <StatTile
          label="Updates today"
          value={formatNumber(data.eventsToday)}
          hint="Received from Telegram"
          icon={Radio}
        />
        <StatTile
          label="Deliveries today"
          value={formatNumber(data.deliveriesToday)}
          hint={`${formatNumber(data.pendingDeliveries)} in the queue`}
          icon={Activity}
        />
        <StatTile
          label="Success rate"
          value={formatPercent(data.successRate)}
          hint={`${formatNumber(data.failedDeliveriesToday)} failed today`}
          icon={data.failedDeliveriesToday > 0 ? AlertTriangle : CheckCircle2}
          tone={successTone}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" padded={false}>
          <div className="p-4">
            <CardHeader
              title="Recent failures"
              description="Deliveries that exhausted their retries"
              actions={
                <Link
                  to="/admin/deliveries?status=failed"
                  className="text-xs font-medium text-accent hover:underline"
                >
                  View all
                </Link>
              }
            />
          </div>

          {data.recentFailures.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No failed deliveries"
              description="Every delivery in the retention window either succeeded or is still in flight."
            />
          ) : (
            <Table>
              <THead>
                <TH>Bot</TH>
                <TH>Event</TH>
                <TH>Destination</TH>
                <TH align="right">Status</TH>
                <TH align="right">When</TH>
              </THead>
              <TBody>
                {data.recentFailures.map((delivery) => (
                  <TR key={delivery.id}>
                    <TD className="font-medium">{delivery.botName}</TD>
                    <TD className="text-text-muted">{delivery.eventType}</TD>
                    <TD
                      className="max-w-56 truncate text-text-muted"
                      title={delivery.destinationUrl ?? ''}
                    >
                      {delivery.destinationName ?? delivery.destinationUrl}
                    </TD>
                    <TD align="right">
                      {delivery.responseStatus ? (
                        <span className="font-mono text-xs text-danger">
                          {delivery.responseStatus}
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-danger">error</span>
                      )}
                    </TD>
                    <TD align="right" className="whitespace-nowrap text-text-faint">
                      {formatRelative(delivery.createdAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Service health" description="Live status of this instance" />
          <dl className="mt-4 space-y-3 text-sm">
            <HealthRow
              icon={Server}
              label="Gateway"
              value={<StatusBadge status={data.health.status} />}
            />
            <HealthRow
              icon={Database}
              label="Database"
              value={<StatusBadge status={data.health.database ? 'ok' : 'error'} />}
            />
            <HealthRow
              icon={Activity}
              label="Delivery worker"
              value={<StatusBadge status={data.health.worker ? 'active' : 'disabled'} />}
            />
            <HealthRow
              icon={Clock}
              label="Uptime"
              value={
                <span className="text-text-muted">{formatUptime(data.health.uptimeSeconds)}</span>
              }
            />
          </dl>

          <div className="mt-4 border-t border-border-base pt-3">
            <p className="text-xs text-text-faint">Public base URL</p>
            <p
              className="mt-0.5 truncate font-mono text-xs text-text-muted"
              title={data.health.publicBaseUrl}
            >
              {data.health.publicBaseUrl}
            </p>
            <p className="mt-2 text-xs text-text-faint">
              Version {data.health.version} · {formatNumber(data.pendingDeliveries)} deliveries
              queued
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}

function HealthRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Server;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2 text-text-muted">
        <Icon className="h-3.5 w-3.5 text-text-faint" aria-hidden />
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
