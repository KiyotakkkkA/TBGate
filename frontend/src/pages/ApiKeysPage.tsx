import { API_SCOPES, type ApiKeyDto, type CreatedApiKeyDto } from '@tg-gateway/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, ConfirmDialog, Modal, useToast } from '@/components/ui/feedback';
import { Button, Checkbox, Field, Input } from '@/components/ui/primitives';
import { Card, EmptyState, ErrorState, PageHeader } from '@/components/ui/surfaces';
import { TBody, TD, TH, THead, TR, Table, TableSkeleton } from '@/components/ui/table';
import { useSession } from '@/hooks/useSession';
import { ApiError, api } from '@/lib/api';
import { copyToClipboard, formatDateTime, formatRelative } from '@/lib/utils';

const SCOPE_HELP: Record<string, string> = {
  'bots:read': 'List bots and read their configuration',
  'telegram:send': 'Send Telegram messages through the gateway',
  'events:read': 'Read received Telegram updates',
  'deliveries:read': 'Read delivery records and attempts',
  'deliveries:retry': 'Replay a delivery',
};

export function ApiKeysPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useSession();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['telegram:send']);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKeyDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyDto | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<ApiKeyDto[]>('/api/v1/api-keys'),
  });

  const create = useMutation({
    mutationFn: (payload: unknown) => api.post<CreatedApiKeyDto>('/api/v1/api-keys', payload),
    onSuccess: async (key) => {
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setCreating(false);
      setName('');
      setScopes(['telegram:send']);
      setCreated(key);
    },
    onError: (caught) => {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not create the API key.');
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/api-keys/${id}/revoke`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('API key revoked');
    },
    onError: (caught) => {
      toast.error('Could not revoke', caught instanceof ApiError ? caught.message : undefined);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/api-keys/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('API key deleted');
      setDeleteTarget(null);
    },
    onError: (caught) => {
      toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
      setDeleteTarget(null);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (scopes.length === 0) {
      setFormError('Select at least one scope.');
      return;
    }
    create.mutate({ name: name.trim(), scopes });
  }

  return (
    <>
      <PageHeader
        title="API keys"
        description="Credentials downstream services use to call the gateway API"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setFormError(null);
              setCreating(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Create API key
          </Button>
        }
      />

      {error ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load API keys.'}
          requestId={error instanceof ApiError ? error.requestId : null}
        />
      ) : (
        <Card padded={false}>
          {isLoading ? (
            <TableSkeleton columns={5} />
          ) : !data || data.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys"
              description="An API key lets a downstream service send Telegram messages through the gateway without ever holding a bot token."
            />
          ) : (
            <Table>
              <THead>
                <TH>Name</TH>
                <TH>Prefix</TH>
                <TH>Scopes</TH>
                {isAdmin ? <TH>Owner</TH> : null}
                <TH align="right">Last used</TH>
                <TH align="right">Created</TH>
                <TH align="right" />
              </THead>
              <TBody>
                {data.map((key) => (
                  <TR key={key.id} className={key.revokedAt ? 'opacity-55' : undefined}>
                    <TD className="font-medium">
                      {key.name}
                      {key.revokedAt ? (
                        <Badge tone="danger" className="ml-2">
                          revoked
                        </Badge>
                      ) : null}
                    </TD>
                    <TD className="font-mono text-xs text-text-muted">{key.prefix}…</TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge key={scope}>{scope}</Badge>
                        ))}
                      </div>
                    </TD>
                    {isAdmin ? (
                      <TD className="text-text-muted">{key.ownerUsername ?? '—'}</TD>
                    ) : null}
                    <TD align="right" className="whitespace-nowrap text-text-faint">
                      {formatRelative(key.lastUsedAt)}
                    </TD>
                    <TD align="right" className="whitespace-nowrap text-text-faint">
                      {formatDateTime(key.createdAt)}
                    </TD>
                    <TD align="right">
                      <div className="flex justify-end gap-1">
                        {key.revokedAt ? null : (
                          <Button size="sm" variant="outline" onClick={() => revoke.mutate(key.id)}>
                            Revoke
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete API key ${key.name}`}
                          onClick={() => setDeleteTarget(key)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create API key"
        description="The key is shown once, right after creation. Only a digest of it is stored."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="api-key-form" loading={create.isPending}>
              Create key
            </Button>
          </>
        }
      >
        <form id="api-key-form" onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Name" htmlFor="key-name" required hint="Where this key will be used.">
            <Input
              id="key-name"
              required
              autoFocus
              placeholder="python-worker"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <div>
            <p className="mb-2 text-xs font-medium text-text">Scopes</p>
            <div className="space-y-2 rounded-lg border border-border-base p-3">
              {API_SCOPES.map((scope) => (
                <Checkbox
                  key={scope}
                  label={scope}
                  description={SCOPE_HELP[scope]}
                  checked={scopes.includes(scope)}
                  onChange={() =>
                    setScopes((current) =>
                      current.includes(scope)
                        ? current.filter((item) => item !== scope)
                        : [...current, scope],
                    )
                  }
                />
              ))}
            </div>
          </div>

          {formError ? (
            <div
              className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
              role="alert"
            >
              {formError}
            </div>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Copy your API key"
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I have saved it
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning-subtle p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <p className="text-xs text-text">
              This is the only time the full key is shown. The gateway stores only a digest and
              cannot display it again.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-bg-subtle p-3 font-mono text-xs break-all">
              {created?.token}
            </code>
            <Button
              variant="outline"
              onClick={async () => {
                if (created && (await copyToClipboard(created.token))) {
                  toast.success('Copied to clipboard');
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copy
            </Button>
          </div>

          <div>
            <p className="text-xs font-medium text-text">Example request</p>
            <pre className="mt-1.5 overflow-x-auto rounded-lg bg-bg-subtle p-3 font-mono text-[11px] text-text-muted">
              {`curl -X POST \\
  "$PUBLIC_BASE_URL/api/v1/bots/<botId>/sendMessage" \\
  -H "Authorization: Bearer ${created?.token ?? '<key>'}" \\
  -H "Content-Type: application/json" \\
  -d '{"chat_id": 123456789, "text": "Hello"}'`}
            </pre>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        loading={remove.isPending}
        title="Delete API key"
        confirmLabel="Delete key"
        message={
          <>
            Any service still using <strong className="text-text">{deleteTarget?.name}</strong> will
            immediately start receiving 401 responses.
          </>
        }
      />
    </>
  );
}
