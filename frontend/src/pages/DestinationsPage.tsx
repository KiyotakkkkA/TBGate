import type { DestinationDto } from '@tg-gateway/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, Plus, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, ConfirmDialog, Modal, StatusBadge, useToast } from '@/components/ui/feedback';
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
} from '@/components/ui/primitives';
import { Card, EmptyState, ErrorState, PageHeader } from '@/components/ui/surfaces';
import { TBody, TD, TH, THead, TR, Table, TableSkeleton } from '@/components/ui/table';
import { useSession } from '@/hooks/useSession';
import { ApiError, api } from '@/lib/api';
import { copyToClipboard, formatRelative } from '@/lib/utils';

interface FormState {
  name: string;
  url: string;
  method: string;
  enabled: boolean;
  signingEnabled: boolean;
  timeoutMs: string;
  headers: string;
  rotateSigningSecret: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  url: '',
  method: 'POST',
  enabled: true,
  signingEnabled: true,
  timeoutMs: '',
  headers: '',
  rotateSigningSecret: false,
};

export function DestinationsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useSession();

  const [editing, setEditing] = useState<DestinationDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DestinationDto | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['destinations'],
    queryFn: () => api.get<DestinationDto[]>('/api/v1/destinations'),
  });

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreating(true);
  }

  function openEdit(destination: DestinationDto) {
    setForm({
      name: destination.name,
      url: destination.url,
      method: destination.method,
      enabled: destination.enabled,
      signingEnabled: destination.signingEnabled,
      timeoutMs: destination.timeoutMs ? String(destination.timeoutMs) : '',
      headers: destination.headers ? JSON.stringify(destination.headers, null, 2) : '',
      rotateSigningSecret: false,
    });
    setFormError(null);
    setEditing(destination);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setFormError(null);
  }

  const save = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      editing
        ? api.patch<DestinationDto>(`/api/v1/destinations/${editing.id}`, payload)
        : api.post<DestinationDto>('/api/v1/destinations', payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['destinations'] });
      toast.success(editing ? 'Destination updated' : 'Destination created');
      closeForm();
    },
    onError: (caught) => {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not save the destination.');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/destinations/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['destinations'] });
      toast.success('Destination deleted');
      setDeleteTarget(null);
    },
    onError: (caught) => {
      toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
      setDeleteTarget(null);
    },
  });

  const reveal = useMutation({
    mutationFn: (destination: DestinationDto) =>
      api
        .post<{ signingSecret: string | null }>(
          `/api/v1/destinations/${destination.id}/reveal-secret`,
        )
        .then((result) => ({ name: destination.name, secret: result.signingSecret })),
    onSuccess: (result) => {
      if (!result.secret) {
        toast.info('No signing secret', 'Signing is disabled for this destination.');
        return;
      }
      setRevealed({ name: result.name, secret: result.secret });
    },
    onError: (caught) => {
      toast.error(
        'Could not reveal secret',
        caught instanceof ApiError ? caught.message : undefined,
      );
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    let headers: Record<string, string> | undefined;
    if (form.headers.trim()) {
      try {
        headers = JSON.parse(form.headers) as Record<string, string>;
      } catch {
        setFormError('Custom headers must be a valid JSON object, e.g. {"x-api-key": "..."}');
        return;
      }
    }

    save.mutate({
      name: form.name.trim(),
      url: form.url.trim(),
      method: form.method,
      enabled: form.enabled,
      signingEnabled: form.signingEnabled,
      ...(form.timeoutMs ? { timeoutMs: Number(form.timeoutMs) } : {}),
      ...(headers ? { headers } : {}),
      ...(editing && form.rotateSigningSecret ? { rotateSigningSecret: true } : {}),
    });
  }

  return (
    <>
      <PageHeader
        title="Destinations"
        description="Downstream services that receive routed Telegram updates"
        actions={
          <Button variant="primary" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add destination
          </Button>
        }
      />

      {error ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load destinations.'}
          requestId={error instanceof ApiError ? error.requestId : null}
        />
      ) : (
        <Card padded={false}>
          {isLoading ? (
            <TableSkeleton columns={5} />
          ) : !data || data.length === 0 ? (
            <EmptyState
              icon={Send}
              title="No destinations yet"
              description="A destination is any HTTP endpoint - an external HTTPS URL or a container on the same Docker network, e.g. http://python-worker:8000/events."
              action={
                <Button variant="primary" onClick={openCreate}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add destination
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TH>Name</TH>
                <TH>URL</TH>
                <TH>Status</TH>
                <TH>Signing</TH>
                {isAdmin ? <TH>Owner</TH> : null}
                <TH align="right">Routes</TH>
                <TH align="right">Updated</TH>
                <TH align="right" />
              </THead>
              <TBody>
                {data.map((destination) => (
                  <TR key={destination.id}>
                    <TD className="font-medium">{destination.name}</TD>
                    <TD
                      className="max-w-72 truncate font-mono text-xs text-text-muted"
                      title={destination.url}
                    >
                      <span className="mr-1.5 rounded bg-bg-subtle px-1 py-0.5 text-[10px] font-medium">
                        {destination.method}
                      </span>
                      {destination.url}
                    </TD>
                    <TD>
                      <StatusBadge status={destination.enabled ? 'enabled' : 'disabled'} />
                    </TD>
                    <TD>
                      {destination.signingEnabled ? (
                        <div className="flex items-center gap-1.5">
                          <Badge tone="success">HMAC</Badge>
                          <span className="font-mono text-[11px] text-text-faint">
                            {destination.signingSecretHint}
                          </span>
                        </div>
                      ) : (
                        <Badge>off</Badge>
                      )}
                    </TD>
                    {isAdmin ? (
                      <TD className="text-text-muted">
                        {destination.ownerUsername ?? <span className="text-text-faint">—</span>}
                      </TD>
                    ) : null}
                    <TD align="right" className="tabular-nums text-text-muted">
                      {destination.routeCount}
                    </TD>
                    <TD align="right" className="whitespace-nowrap text-text-faint">
                      {formatRelative(destination.updatedAt)}
                    </TD>
                    <TD align="right">
                      <div className="flex justify-end gap-1">
                        {destination.signingEnabled ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Reveal signing secret"
                            aria-label={`Reveal signing secret for ${destination.name}`}
                            onClick={() => reveal.mutate(destination)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                        <Button size="sm" variant="outline" onClick={() => openEdit(destination)}>
                          Edit
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Delete destination"
                          aria-label={`Delete ${destination.name}`}
                          onClick={() => setDeleteTarget(destination)}
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
        open={creating || editing !== null}
        onClose={closeForm}
        title={editing ? 'Edit destination' : 'New destination'}
        description="Requests are POSTed as JSON and signed with HMAC-SHA256 when signing is enabled."
        footer={
          <>
            <Button variant="secondary" onClick={closeForm}>
              Cancel
            </Button>
            <Button
              variant="primary"
              form="destination-form"
              type="submit"
              loading={save.isPending}
            >
              {editing ? 'Save changes' : 'Create destination'}
            </Button>
          </>
        }
      >
        <form id="destination-form" onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Name" htmlFor="dest-name" required>
            <Input
              id="dest-name"
              required
              value={form.name}
              placeholder="Python worker"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>

          <Field
            label="URL"
            htmlFor="dest-url"
            required
            hint="http:// or https:// only. Docker service names work, e.g. http://python-worker:8000/events"
          >
            <Input
              id="dest-url"
              required
              spellCheck={false}
              value={form.url}
              placeholder="http://python-worker:8000/events"
              onChange={(event) => setForm({ ...form, url: event.target.value })}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Method" htmlFor="dest-method">
              <Select
                id="dest-method"
                value={form.method}
                onChange={(event) => setForm({ ...form, method: event.target.value })}
              >
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
              </Select>
            </Field>

            <Field
              label="Timeout (ms)"
              htmlFor="dest-timeout"
              hint="Blank uses DELIVERY_TIMEOUT_MS"
            >
              <Input
                id="dest-timeout"
                inputMode="numeric"
                placeholder="10000"
                value={form.timeoutMs}
                onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })}
              />
            </Field>
          </div>

          <Field
            label="Custom headers"
            htmlFor="dest-headers"
            hint='Optional JSON object, e.g. {"x-api-key": "secret"}. Signature headers cannot be overridden.'
          >
            <Textarea
              id="dest-headers"
              rows={3}
              spellCheck={false}
              value={form.headers}
              onChange={(event) => setForm({ ...form, headers: event.target.value })}
            />
          </Field>

          <div className="space-y-2.5 rounded-lg border border-border-base bg-bg-subtle p-3">
            <Switch
              checked={form.enabled}
              onChange={(checked) => setForm({ ...form, enabled: checked })}
              label="Enabled"
            />
            <Switch
              checked={form.signingEnabled}
              onChange={(checked) => setForm({ ...form, signingEnabled: checked })}
              label="Sign requests with HMAC-SHA256"
            />
            {editing && form.signingEnabled ? (
              <Checkbox
                label="Rotate the signing secret"
                description="The current secret stops working immediately after saving."
                checked={form.rotateSigningSecret}
                onChange={(event) =>
                  setForm({ ...form, rotateSigningSecret: event.target.checked })
                }
              />
            ) : null}
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
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title="Signing secret"
        description={`Use this value to verify signatures from ${revealed?.name ?? ''}.`}
        footer={
          <Button variant="secondary" onClick={() => setRevealed(null)}>
            Done
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-bg-subtle p-3 font-mono text-xs break-all">
              {revealed?.secret}
            </code>
            <Button
              variant="outline"
              onClick={async () => {
                if (revealed && (await copyToClipboard(revealed.secret))) {
                  toast.success('Copied to clipboard');
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copy
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Store it in your downstream service&apos;s configuration. The signature is computed over{' '}
            <code className="font-mono">timestamp + &quot;.&quot; + rawBody</code> and sent in{' '}
            <code className="font-mono">X-TG-Gateway-Signature</code>.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        loading={remove.isPending}
        title="Delete destination"
        confirmLabel="Delete destination"
        message={
          <>
            <strong className="text-text">{deleteTarget?.name}</strong> will be deleted, along with{' '}
            {deleteTarget?.routeCount ?? 0} route(s) pointing at it. Delivery history is preserved.
            This cannot be undone.
          </>
        }
      />
    </>
  );
}
