import { TELEGRAM_UPDATE_TYPES, type BotDto, type WebhookInfoDto } from '@tg-gateway/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Copy, Loader2, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RoutesPanel } from '@/components/bots/RoutesPanel';
import { DeliveriesPanel } from '@/components/deliveries/DeliveriesPanel';
import { EventsPanel } from '@/components/events/EventsPanel';
import { Badge, ConfirmDialog, StatusBadge, useToast } from '@/components/ui/feedback';
import { Button, Checkbox, Switch } from '@/components/ui/primitives';
import { Card, CardHeader, ErrorState, PageHeader } from '@/components/ui/surfaces';
import { ApiError, api } from '@/lib/api';
import { cn, copyToClipboard, formatDateTime, formatNumber, humanizeUpdateType } from '@/lib/utils';

const TABS = ['Overview', 'Telegram', 'Routes', 'Events', 'Deliveries', 'Settings'] as const;
type Tab = (typeof TABS)[number];

export function BotDetailPage() {
  const { botId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>('Overview');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const bot = useQuery({
    queryKey: ['bot', botId],
    queryFn: () => api.get<BotDto>(`/api/v1/bots/${botId}`),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['bot', botId] });
    await queryClient.invalidateQueries({ queryKey: ['bots'] });
  };

  const update = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.patch<BotDto>(`/api/v1/bots/${botId}`, payload),
    onSuccess: async () => {
      await invalidate();
      toast.success('Bot updated');
    },
    onError: (error) => {
      toast.error('Could not update bot', error instanceof ApiError ? error.message : undefined);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/v1/bots/${botId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bots'] });
      toast.success('Bot deleted');
      navigate('/admin/bots');
    },
    onError: (error) => {
      toast.error('Could not delete bot', error instanceof ApiError ? error.message : undefined);
      setConfirmDelete(false);
    },
  });

  if (bot.error) {
    return (
      <>
        <PageHeader title="Bot" />
        <ErrorState
          message={bot.error instanceof ApiError ? bot.error.message : 'Could not load this bot.'}
          requestId={bot.error instanceof ApiError ? bot.error.requestId : null}
          action={
            <Link to="/admin/bots">
              <Button variant="secondary">Back to bots</Button>
            </Link>
          }
        />
      </>
    );
  }

  if (bot.isLoading || !bot.data) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-text-faint" aria-label="Loading" />
      </div>
    );
  }

  const data = bot.data;

  return (
    <>
      <PageHeader
        title={data.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {data.telegramUsername ? (
              <span className="font-mono text-xs">@{data.telegramUsername}</span>
            ) : null}
            <StatusBadge status={data.enabled ? 'enabled' : 'disabled'} />
            <StatusBadge status={data.webhookState} />
          </span>
        }
        actions={
          <>
            <Link to="/admin/bots">
              <Button variant="ghost">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                All bots
              </Button>
            </Link>
            <Switch
              checked={data.enabled}
              onChange={(checked) => update.mutate({ enabled: checked })}
              label={data.enabled ? 'Enabled' : 'Disabled'}
            />
          </>
        }
      />

      {data.webhookState === 'mismatch' && data.webhookLastError ? (
        <Card className="mb-4 border-warning/40 bg-warning-subtle/50">
          <div className="flex gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div>
              <p className="text-sm font-medium">Webhook URL mismatch</p>
              <p className="mt-0.5 text-xs text-text-muted">{data.webhookLastError}</p>
            </div>
          </div>
        </Card>
      ) : null}

      <div
        className="mb-4 flex gap-1 overflow-x-auto border-b border-border-base"
        role="tablist"
        aria-label="Bot sections"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              tab === name
                ? 'border-accent text-accent'
                : 'border-transparent text-text-muted hover:text-text',
            )}
          >
            {name}
          </button>
        ))}
      </div>

      {tab === 'Overview' ? <OverviewTab bot={data} /> : null}
      {tab === 'Telegram' ? <TelegramTab bot={data} onChanged={invalidate} /> : null}
      {tab === 'Routes' ? <RoutesPanel botId={botId} /> : null}
      {tab === 'Events' ? <EventsPanel botId={botId} showFilters={false} pageSize={15} /> : null}
      {tab === 'Deliveries' ? (
        <DeliveriesPanel botId={botId} showFilters={false} pageSize={15} />
      ) : null}
      {tab === 'Settings' ? (
        <SettingsTab
          bot={data}
          onUpdate={(payload) => update.mutate(payload)}
          saving={update.isPending}
          onDelete={() => setConfirmDelete(true)}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete bot"
        confirmLabel="Delete bot"
        message={
          <>
            <strong className="text-text">{data.name}</strong>, its routes, stored events and
            delivery history will be deleted permanently. The Telegram webhook is removed first.
            This cannot be undone.
          </>
        }
      />
    </>
  );
}

function OverviewTab({ bot }: { bot: BotDto }) {
  const toast = useToast();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Identity" />
        <dl className="mt-3 space-y-2.5">
          <Row label="Gateway bot ID" value={<code className="font-mono text-xs">{bot.id}</code>} />
          <Row label="Telegram bot ID" value={bot.telegramBotId ?? '—'} />
          <Row
            label="Telegram username"
            value={bot.telegramUsername ? `@${bot.telegramUsername}` : '—'}
          />
          <Row
            label="Token"
            value={
              <span className="flex items-center gap-1.5">
                <code className="font-mono text-xs">{bot.tokenHint ?? '—'}</code>
                <Badge tone="success">encrypted</Badge>
              </span>
            }
          />
          <Row label="Owner" value={bot.ownerUsername ?? '—'} />
          <Row label="Created" value={formatDateTime(bot.createdAt)} />
        </dl>
      </Card>

      <Card>
        <CardHeader title="Activity" />
        <dl className="mt-3 space-y-2.5">
          <Row label="Routes" value={formatNumber(bot.routeCount)} />
          <Row label="Events stored" value={formatNumber(bot.eventCount)} />
          <Row label="Last update" value={formatDateTime(bot.lastUpdateAt)} />
          <Row label="Webhook state" value={<StatusBadge status={bot.webhookState} />} />
          <Row label="Webhook registered" value={formatDateTime(bot.webhookLastSetAt)} />
        </dl>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader
          title="Webhook URL"
          description="Telegram posts updates here. The bot token never appears in this URL."
          actions={
            <Button
              variant="outline"
              onClick={async () => {
                if (await copyToClipboard(bot.webhookUrl)) toast.success('Copied to clipboard');
              }}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copy
            </Button>
          }
        />
        <code className="mt-3 block rounded-lg bg-bg-subtle p-3 font-mono text-xs break-all">
          {bot.webhookUrl}
        </code>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-right text-text">{value}</dd>
    </div>
  );
}

function TelegramTab({ bot, onChanged }: { bot: BotDto; onChanged: () => Promise<void> }) {
  const toast = useToast();

  const info = useQuery({
    queryKey: ['webhook-info', bot.id],
    queryFn: () => api.get<WebhookInfoDto>(`/api/v1/bots/${bot.id}/webhook`),
    retry: false,
  });

  const testConnection = useMutation({
    mutationFn: () =>
      api.post<{ id: number; username: string | null; firstName: string }>(
        `/api/v1/bots/${bot.id}/telegram/test`,
      ),
    onSuccess: (result) => {
      toast.success(
        'Telegram connection OK',
        `getMe returned ${result.username ? `@${result.username}` : result.firstName} (id ${result.id}).`,
      );
    },
    onError: (error) => {
      toast.error(
        'Telegram rejected the call',
        error instanceof ApiError ? error.message : undefined,
      );
    },
  });

  const registerWebhook = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/api/v1/bots/${bot.id}/webhook`),
    onSuccess: async () => {
      await onChanged();
      await info.refetch();
      toast.success('Webhook registered');
    },
    onError: (error) => {
      toast.error(
        'Could not register webhook',
        error instanceof ApiError ? error.message : undefined,
      );
    },
  });

  const deleteWebhook = useMutation({
    mutationFn: () => api.delete(`/api/v1/bots/${bot.id}/webhook`),
    onSuccess: async () => {
      await onChanged();
      await info.refetch();
      toast.success('Webhook removed', 'Telegram will stop sending updates to this gateway.');
    },
    onError: (error) => {
      toast.error(
        'Could not remove webhook',
        error instanceof ApiError ? error.message : undefined,
      );
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Telegram connection"
          description="Actions that talk to the Telegram Bot API using the stored token"
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                loading={testConnection.isPending}
                onClick={() => testConnection.mutate()}
              >
                Test connection
              </Button>
              <Button
                variant="primary"
                loading={registerWebhook.isPending}
                onClick={() => registerWebhook.mutate()}
              >
                {bot.webhookState === 'active' ? 'Re-register webhook' : 'Register webhook'}
              </Button>
              <Button
                variant="outline"
                loading={deleteWebhook.isPending}
                onClick={() => deleteWebhook.mutate()}
              >
                Delete webhook
              </Button>
            </div>
          }
        />
      </Card>

      <Card>
        <CardHeader
          title="Webhook status (live from Telegram)"
          actions={
            <Button variant="ghost" loading={info.isFetching} onClick={() => void info.refetch()}>
              Refresh
            </Button>
          }
        />
        {info.error ? (
          <p className="mt-3 text-sm text-danger">
            {info.error instanceof ApiError ? info.error.message : 'Could not reach Telegram.'}
          </p>
        ) : info.isLoading || !info.data ? (
          <p className="mt-3 text-sm text-text-muted">Querying Telegram…</p>
        ) : (
          <dl className="mt-3 space-y-2.5">
            <Row label="State" value={<StatusBadge status={info.data.state} />} />
            <Row
              label="Registered URL"
              value={
                <code className="font-mono text-xs break-all">
                  {info.data.url || 'not configured'}
                </code>
              }
            />
            <Row
              label="Expected URL"
              value={<code className="font-mono text-xs break-all">{info.data.expectedUrl}</code>}
            />
            <Row label="Pending updates" value={formatNumber(info.data.pendingUpdateCount)} />
            <Row label="Max connections" value={info.data.maxConnections ?? '—'} />
            <Row
              label="Allowed updates"
              value={
                info.data.allowedUpdates && info.data.allowedUpdates.length > 0 ? (
                  <span className="flex flex-wrap justify-end gap-1">
                    {info.data.allowedUpdates.map((type) => (
                      <Badge key={type}>{type}</Badge>
                    ))}
                  </span>
                ) : (
                  'Telegram default set'
                )
              }
            />
            {info.data.lastErrorMessage ? (
              <Row
                label="Last Telegram error"
                value={<span className="text-danger">{info.data.lastErrorMessage}</span>}
              />
            ) : null}
          </dl>
        )}
      </Card>
    </div>
  );
}

function SettingsTab({
  bot,
  onUpdate,
  saving,
  onDelete,
}: {
  bot: BotDto;
  onUpdate: (payload: Record<string, unknown>) => void;
  saving: boolean;
  onDelete: () => void;
}) {
  const [allowedUpdates, setAllowedUpdates] = useState<string[]>(bot.allowedUpdates);

  function toggle(type: string) {
    setAllowedUpdates((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  }

  const dirty =
    allowedUpdates.length !== bot.allowedUpdates.length ||
    allowedUpdates.some((type) => !bot.allowedUpdates.includes(type));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Allowed update types"
          description="Saving re-registers the Telegram webhook with the new list."
          actions={
            <Button
              variant="primary"
              disabled={!dirty}
              loading={saving}
              onClick={() => onUpdate({ allowedUpdates })}
            >
              Save changes
            </Button>
          }
        />
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {TELEGRAM_UPDATE_TYPES.map((type) => (
            <Checkbox
              key={type}
              label={humanizeUpdateType(type)}
              checked={allowedUpdates.includes(type)}
              onChange={() => toggle(type)}
            />
          ))}
        </div>
        {allowedUpdates.length === 0 ? (
          <p className="mt-3 text-xs text-text-faint">
            Nothing selected: Telegram will send its default set of update types.
          </p>
        ) : null}
      </Card>

      <Card className="border-danger/30">
        <CardHeader
          title="Danger zone"
          description="Deleting a bot removes its routes, events and delivery history."
          actions={
            <Button variant="danger" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete bot
            </Button>
          }
        />
      </Card>
    </div>
  );
}
