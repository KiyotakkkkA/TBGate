import type { BotDto, EventDetailDto, EventDto, Paginated } from '@tg-gateway/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RadioTower, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Badge, Modal, useToast } from '@/components/ui/feedback';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { Card, EmptyState, ErrorState } from '@/components/ui/surfaces';
import { Pagination, TBody, TD, TH, THead, TR, Table, TableSkeleton } from '@/components/ui/table';
import { ApiError, api } from '@/lib/api';
import { TELEGRAM_UPDATE_TYPES } from '@tg-gateway/shared';
import { formatDateTime, formatRelative, humanizeUpdateType } from '@/lib/utils';

export interface EventsPanelProps {
  botId?: string;
  showFilters?: boolean;
  pageSize?: number;
}

export function EventsPanel({ botId, showFilters = true, pageSize = 25 }: EventsPanelProps) {
  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState('');
  const [botFilter, setBotFilter] = useState('');
  const [chatId, setChatId] = useState('');
  const [updateId, setUpdateId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const effectiveBotId = botId ?? (botFilter || undefined);

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: () => api.get<BotDto[]>('/api/v1/bots'),
    enabled: showFilters && !botId,
  });

  const query = useQuery({
    queryKey: ['events', { page, eventType, botId: effectiveBotId, chatId, updateId, pageSize }],
    queryFn: () =>
      api.get<Paginated<EventDto>>('/api/v1/events', {
        page,
        pageSize,
        botId: effectiveBotId,
        eventType: eventType || undefined,
        chatId: chatId || undefined,
        updateId: updateId || undefined,
      }),
    refetchInterval: 15_000,
  });

  function resetToFirstPage<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  return (
    <>
      {showFilters ? (
        <Card className="mb-3">
          <div className="flex flex-wrap items-end gap-3">
            {!botId ? (
              <Field label="Bot" htmlFor="event-bot" className="w-52">
                <Select
                  id="event-bot"
                  value={botFilter}
                  onChange={(event) => resetToFirstPage(setBotFilter)(event.target.value)}
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

            <Field label="Update type" htmlFor="event-type" className="w-52">
              <Select
                id="event-type"
                value={eventType}
                onChange={(event) => resetToFirstPage(setEventType)(event.target.value)}
              >
                <option value="">All types</option>
                {TELEGRAM_UPDATE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {humanizeUpdateType(type)}
                  </option>
                ))}
                <option value="unknown">Unknown</option>
              </Select>
            </Field>

            <Field label="Chat ID" htmlFor="event-chat" className="w-40">
              <Input
                id="event-chat"
                inputMode="numeric"
                placeholder="Any"
                value={chatId}
                onChange={(event) => resetToFirstPage(setChatId)(event.target.value)}
              />
            </Field>

            <Field label="Update ID" htmlFor="event-update" className="w-40">
              <Input
                id="event-update"
                inputMode="numeric"
                placeholder="Any"
                value={updateId}
                onChange={(event) => resetToFirstPage(setUpdateId)(event.target.value)}
              />
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
          message={query.error instanceof ApiError ? query.error.message : 'Could not load events.'}
          requestId={query.error instanceof ApiError ? query.error.requestId : null}
        />
      ) : (
        <Card padded={false}>
          {query.isLoading ? (
            <TableSkeleton columns={6} />
          ) : !query.data || query.data.items.length === 0 ? (
            <EmptyState
              icon={RadioTower}
              title="No events yet"
              description="Updates appear here as soon as Telegram delivers them to this gateway."
            />
          ) : (
            <>
              <Table>
                <THead>
                  <TH>Received</TH>
                  <TH>Bot</TH>
                  <TH>Type</TH>
                  <TH align="right">Update ID</TH>
                  <TH align="right">Chat ID</TH>
                  <TH align="right">Deliveries</TH>
                </THead>
                <TBody>
                  {query.data.items.map((event) => (
                    <TR key={event.id} onClick={() => setSelectedId(event.id)}>
                      <TD className="whitespace-nowrap text-text-muted">
                        {formatRelative(event.receivedAt)}
                      </TD>
                      <TD className="font-medium">{event.botName}</TD>
                      <TD>
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-muted">{event.eventType}</span>
                          {event.isTest ? <Badge tone="accent">test</Badge> : null}
                        </div>
                      </TD>
                      <TD align="right" className="font-mono text-xs text-text-muted">
                        {event.telegramUpdateId ?? '—'}
                      </TD>
                      <TD align="right" className="font-mono text-xs text-text-muted">
                        {event.chatId ?? '—'}
                      </TD>
                      <TD align="right" className="tabular-nums text-text-muted">
                        {event.deliveryCount}
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

      <EventDetailModal eventId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

function EventDetailModal({ eventId, onClose }: { eventId: string | null; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => api.get<EventDetailDto>(`/api/v1/events/${eventId}`),
    enabled: Boolean(eventId),
  });

  const replay = useMutation({
    mutationFn: () => api.post<{ deliveries: number }>(`/api/v1/events/${eventId}/replay`),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      await queryClient.invalidateQueries({ queryKey: ['events'] });
      toast.success(
        'Event replayed',
        `${result.deliveries} new ${result.deliveries === 1 ? 'delivery' : 'deliveries'} queued.`,
      );
      onClose();
    },
    onError: (error) => {
      toast.error('Could not replay', error instanceof ApiError ? error.message : undefined);
    },
  });

  return (
    <Modal
      open={Boolean(eventId)}
      onClose={onClose}
      title="Telegram update"
      description={
        data ? `${data.eventType} · received ${formatDateTime(data.receivedAt)}` : undefined
      }
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={replay.isPending} onClick={() => replay.mutate()}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Re-run routing
          </Button>
        </>
      }
    >
      {isLoading || !data ? (
        <p className="py-6 text-center text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-xs text-text-faint">Bot</p>
              <p className="mt-0.5">{data.botName}</p>
            </div>
            <div>
              <p className="text-xs text-text-faint">Update ID</p>
              <p className="mt-0.5 font-mono text-xs">{data.telegramUpdateId ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-text-faint">Chat ID</p>
              <p className="mt-0.5 font-mono text-xs">{data.chatId ?? '—'}</p>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-text">Raw Telegram payload</p>
            <pre className="max-h-96 overflow-auto rounded-lg bg-bg-subtle p-3 font-mono text-[11px] whitespace-pre-wrap text-text-muted">
              {JSON.stringify(data.payload, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </Modal>
  );
}
