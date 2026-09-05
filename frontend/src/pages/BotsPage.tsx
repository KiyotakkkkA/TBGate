import type { BotDto } from '@tg-gateway/shared';
import { useQuery } from '@tanstack/react-query';
import { Bot, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, StatusBadge } from '@/components/ui/feedback';
import { Button } from '@/components/ui/primitives';
import { Card, EmptyState, ErrorState, PageHeader } from '@/components/ui/surfaces';
import { TBody, TD, TH, THead, TR, Table, TableSkeleton } from '@/components/ui/table';
import { useSession } from '@/hooks/useSession';
import { ApiError, api } from '@/lib/api';
import { formatNumber, formatRelative } from '@/lib/utils';

export function BotsPage() {
  const navigate = useNavigate();
  const { isAdmin } = useSession();
  const { data, isLoading, error } = useQuery({
    queryKey: ['bots'],
    queryFn: () => api.get<BotDto[]>('/api/v1/bots'),
  });

  return (
    <>
      <PageHeader
        title="Bots"
        description="Telegram bots this gateway receives updates for"
        actions={
          <Link to="/admin/bots/new">
            <Button variant="primary">
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add bot
            </Button>
          </Link>
        }
      />

      {error ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load bots.'}
          requestId={error instanceof ApiError ? error.requestId : null}
        />
      ) : (
        <Card padded={false}>
          {isLoading ? (
            <TableSkeleton columns={6} />
          ) : !data || data.length === 0 ? (
            <EmptyState
              icon={Bot}
              title="No bots yet"
              description="Add a bot with its @BotFather token. The gateway validates it, encrypts it, and registers the Telegram webhook for you."
              action={
                <Link to="/admin/bots/new">
                  <Button variant="primary">
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add your first bot
                  </Button>
                </Link>
              }
            />
          ) : (
            <Table>
              <THead>
                <TH>Bot</TH>
                <TH>Status</TH>
                <TH>Webhook</TH>
                {isAdmin ? <TH>Owner</TH> : null}
                <TH align="right">Routes</TH>
                <TH align="right">Updates</TH>
                <TH align="right">Last update</TH>
              </THead>
              <TBody>
                {data.map((bot) => (
                  <TR key={bot.id} onClick={() => navigate(`/admin/bots/${bot.id}`)}>
                    <TD>
                      <div className="min-w-0">
                        <p className="font-medium text-text">{bot.name}</p>
                        <p className="truncate text-xs text-text-faint">
                          {bot.telegramUsername ? `@${bot.telegramUsername}` : bot.telegramBotId}
                        </p>
                      </div>
                    </TD>
                    <TD>
                      <StatusBadge status={bot.enabled ? 'enabled' : 'disabled'} />
                    </TD>
                    <TD>
                      <StatusBadge status={bot.webhookState} />
                    </TD>
                    {isAdmin ? (
                      <TD className="text-text-muted">
                        {bot.ownerUsername ? (
                          <Badge>{bot.ownerUsername}</Badge>
                        ) : (
                          <span className="text-text-faint">—</span>
                        )}
                      </TD>
                    ) : null}
                    <TD align="right" className="tabular-nums text-text-muted">
                      {formatNumber(bot.routeCount)}
                    </TD>
                    <TD align="right" className="tabular-nums text-text-muted">
                      {formatNumber(bot.eventCount)}
                    </TD>
                    <TD align="right" className="whitespace-nowrap text-text-faint">
                      {formatRelative(bot.lastUpdateAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
