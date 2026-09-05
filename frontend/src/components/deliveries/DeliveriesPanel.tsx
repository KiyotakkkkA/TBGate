import type { BotDto, DeliveryDetailDto, DeliveryDto, Paginated } from '@tg-gateway/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, RefreshCw, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Modal, StatusBadge, useToast } from '@/components/ui/feedback';
import { Button, Field, Select } from '@/components/ui/primitives';
import { Card, EmptyState, ErrorState } from '@/components/ui/surfaces';
import { Pagination, TBody, TD, TH, THead, TR, Table, TableSkeleton } from '@/components/ui/table';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatDuration, formatRelative } from '@/lib/utils';

const STATUSES = ['pending', 'processing', 'retrying', 'success', 'failed'] as const;

export interface DeliveriesPanelProps {
  /** When set, the panel is locked to one bot and the bot filter is hidden. */
  botId?: string;
  initialStatus?: string;
  showFilters?: boolean;
  pageSize?: number;
}

export function DeliveriesPanel({
  botId,
  initialStatus = '',
  showFilters = true,
  pageSize = 25,
}: DeliveriesPanelProps) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(initialStatus);
  const [botFilter, setBotFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const effectiveBotId = botId ?? (botFilter || undefined);

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: () => api.get<BotDto[]>('/api/v1/bots'),
    enabled: showFilters && !botId,
  });

  const query = useQuery({
    queryKey: ['deliveries', { page, status, botId: effectiveBotId, pageSize }],
    queryFn: () =>
      api.get<Paginated<DeliveryDto>>('/api/v1/deliveries', {
        page,
        pageSize,
        status: status || undefined,
        botId: effectiveBotId,
      }),
    refetchInterval: 10_000,
  });

  return (
    <>
      {showFilters ? (
        <Card className="mb-3">
          <div className="flex flex-wrap items-end gap-3">
            {!botId ? (
              <Field label="Bot" htmlFor="delivery-bot" className="w-52">
                <Select
                  id="delivery-bot"
                  value={botFilter}
                  onChange={(event) => {
                    setBotFilter(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All bots</option>
                  {bots?.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <Field label="Status" htmlFor="delivery-status" className="w-44">
              <Select
                id="delivery-status"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>

            <Button
              variant="outline"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </Button>
          </div>
        </Card>
      ) : null}

      {query.error ? (
        <ErrorState
          message={
            query.error instanceof ApiError ? query.error.message : 'Could not load deliveries.'
          }
          requestId={query.error instanceof ApiError ? query.error.requestId : null}
        />
      ) : (
        <Card padded={false}>
          {query.isLoading ? (
            <TableSkeleton columns={7} />
          ) : !query.data || query.data.items.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No deliveries"
              description="Deliveries appear here once a Telegram update matches one of your routes."
            />
          ) : (
            <>
              <Table>
                <THead>
                  <TH>When</TH>
                  <TH>Bot</TH>
                  <TH>Event</TH>
                  <TH>Destination</TH>
                  <TH>Status</TH>
                  <TH align="right">HTTP</TH>
                  <TH align="right">Time</TH>
                  <TH align="right">Attempts</TH>
                </THead>
                <TBody>
                  {query.data.items.map((delivery) => (
                    <TR key={delivery.id} onClick={() => setSelectedId(delivery.id)}>
                      <TD className="whitespace-nowrap text-text-muted">
                        {formatRelative(delivery.createdAt)}
                      </TD>
                      <TD className="font-medium">{delivery.botName}</TD>
                      <TD>
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-muted">{delivery.eventType}</span>
                          {delivery.isTest ? <Badge tone="accent">test</Badge> : null}
                          {delivery.isReplay ? <Badge tone="warning">replay</Badge> : null}
                        </div>
                      </TD>
                      <TD
                        className="max-w-56 truncate text-text-muted"
                        title={delivery.destinationUrl ?? ''}
                      >
                        {delivery.destinationName ?? delivery.destinationUrl}
                      </TD>
                      <TD>
                        <StatusBadge status={delivery.status} />
                      </TD>
                      <TD align="right" className="font-mono text-xs">
                        {delivery.responseStatus ?? <span className="text-text-faint">—</span>}
                      </TD>
                      <TD align="right" className="whitespace-nowrap tabular-nums text-text-muted">
                        {formatDuration(delivery.durationMs)}
                      </TD>
                      <TD align="right" className="tabular-nums text-text-muted">
                        {delivery.attemptCount}/{delivery.maxAttempts}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination
                page={query.data.page}
                pageSize={query.data.pageSize}
                total={query.data.total}
                onPageChange={setPage}
              />
            </>
          )}
        </Card>
      )}

      <DeliveryDetailModal deliveryId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

function DeliveryDetailModal({
  deliveryId,
  onClose,
}: {
  deliveryId: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['delivery', deliveryId],
    queryFn: () => api.get<DeliveryDetailDto>(`/api/v1/deliveries/${deliveryId}`),
    enabled: Boolean(deliveryId),
  });

  const retry = useMutation({
    mutationFn: () => api.post<DeliveryDto>(`/api/v1/deliveries/${deliveryId}/retry`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      toast.success('Replay queued', 'A new delivery was created; the original record is kept.');
      onClose();
    },
    onError: (error) => {
      toast.error('Could not replay', error instanceof ApiError ? error.message : undefined);
    },
  });

  return (
    <Modal
      open={Boolean(deliveryId)}
      onClose={onClose}
      title="Delivery detail"
      description={
        data ? `${data.eventType} → ${data.destinationName ?? 'destination'}` : undefined
      }
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={retry.isPending} onClick={() => retry.mutate()}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Replay delivery
          </Button>
        </>
      }
    >
      {isLoading || !data ? (
        <p className="py-6 text-center text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Status" value={<StatusBadge status={data.status} />} />
            <Detail label="Attempts" value={`${data.attemptCount} of ${data.maxAttempts}`} />
            <Detail label="Created" value={formatDateTime(data.createdAt)} />
            <Detail label="Completed" value={formatDateTime(data.completedAt)} />
            <Detail
              label="Next attempt"
              value={data.status === 'retrying' ? formatDateTime(data.nextAttemptAt) : '—'}
            />
            <Detail label="Duration" value={formatDuration(data.durationMs)} />
            <Detail
              label="Destination"
              value={<span className="font-mono text-xs break-all">{data.destinationUrl}</span>}
              wide
            />
            <Detail
              label="Delivery ID"
              value={<span className="font-mono text-xs">{data.id}</span>}
              wide
            />
          </dl>

          {data.lastError ? (
            <div className="rounded-lg border border-danger/30 bg-danger-subtle p-3">
              <p className="text-xs font-medium text-danger">Last error</p>
              <p className="mt-1 text-xs break-words text-text">{data.lastError}</p>
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs font-medium text-text">Attempts</p>
            <div className="overflow-hidden rounded-lg border border-border-base">
              <Table>
                <THead>
                  <TH>#</TH>
                  <TH>Started</TH>
                  <TH align="right">HTTP</TH>
                  <TH align="right">Time</TH>
                  <TH>Result</TH>
                </THead>
                <TBody>
                  {data.attempts.map((attempt) => (
                    <TR key={attempt.id}>
                      <TD className="tabular-nums">{attempt.attempt}</TD>
                      <TD className="whitespace-nowrap text-text-muted">
                        {formatDateTime(attempt.startedAt)}
                      </TD>
                      <TD align="right" className="font-mono text-xs">
                        {attempt.responseStatus ?? '—'}
                      </TD>
                      <TD align="right" className="tabular-nums text-text-muted">
                        {formatDuration(attempt.durationMs)}
                      </TD>
                      <TD>
                        {attempt.succeeded ? (
                          <Badge tone="success">ok</Badge>
                        ) : (
                          <span className="text-xs text-danger">
                            {attempt.errorCode ?? 'failed'}
                          </span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </div>

          {data.attempts.some((attempt) => attempt.responseBody) ? (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text">Last response body</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-bg-subtle p-3 font-mono text-[11px] break-words whitespace-pre-wrap text-text-muted">
                {data.attempts.filter((attempt) => attempt.responseBody).at(-1)?.responseBody}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function Detail({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-text">{value}</dd>
    </div>
  );
}
