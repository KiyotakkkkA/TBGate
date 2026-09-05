import { TELEGRAM_UPDATE_TYPES, type DestinationDto, type RouteDto } from '@tg-gateway/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Plus, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, ConfirmDialog, Modal, StatusBadge, useToast } from '@/components/ui/feedback';
import { Button, Checkbox, Field, Input, Select, Switch } from '@/components/ui/primitives';
import { Card, EmptyState, ErrorState } from '@/components/ui/surfaces';
import { TBody, TD, TH, THead, TR, Table, TableSkeleton } from '@/components/ui/table';
import { ApiError, api } from '@/lib/api';
import { humanizeUpdateType } from '@/lib/utils';

interface FormState {
  name: string;
  destinationId: string;
  updateTypes: string[];
  enabled: boolean;
  priority: string;
  chatIdFilter: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  destinationId: '',
  updateTypes: ['message'],
  enabled: true,
  priority: '100',
  chatIdFilter: '',
};

/** Route management for one bot: which update types go to which destination. */
export function RoutesPanel({ botId }: { botId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<RouteDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RouteDto | null>(null);

  const routes = useQuery({
    queryKey: ['routes', botId],
    queryFn: () => api.get<RouteDto[]>(`/api/v1/bots/${botId}/routes`),
  });

  const destinations = useQuery({
    queryKey: ['destinations'],
    queryFn: () => api.get<DestinationDto[]>('/api/v1/destinations'),
  });

  function openCreate() {
    setForm({ ...EMPTY_FORM, destinationId: destinations.data?.[0]?.id ?? '' });
    setFormError(null);
    setCreating(true);
  }

  function openEdit(route: RouteDto) {
    setForm({
      name: route.name,
      destinationId: route.destinationId,
      updateTypes: route.updateTypes,
      enabled: route.enabled,
      priority: String(route.priority),
      chatIdFilter: route.chatIdFilter ?? '',
    });
    setFormError(null);
    setEditing(route);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
  }

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      editing
        ? api.patch<RouteDto>(`/api/v1/routes/${editing.id}`, payload)
        : api.post<RouteDto>(`/api/v1/bots/${botId}/routes`, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['routes', botId] });
      await queryClient.invalidateQueries({ queryKey: ['bots'] });
      toast.success(editing ? 'Route updated' : 'Route created');
      closeForm();
    },
    onError: (caught) => {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not save the route.');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/routes/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['routes', botId] });
      toast.success('Route deleted');
      setDeleteTarget(null);
    },
    onError: (caught) => {
      toast.error('Could not delete', caught instanceof ApiError ? caught.message : undefined);
      setDeleteTarget(null);
    },
  });

  const test = useMutation({
    mutationFn: (route: RouteDto) =>
      api.post<{ deliveries: number; eventType: string }>(`/api/v1/routes/${route.id}/test`, {
        eventType: route.updateTypes.includes('*') ? 'message' : route.updateTypes[0],
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      toast.success(
        'Test event queued',
        `A synthetic ${result.eventType} update was sent. It is flagged as a test, not as real Telegram traffic.`,
      );
    },
    onError: (caught) => {
      toast.error('Could not send test', caught instanceof ApiError ? caught.message : undefined);
    },
  });

  function toggleUpdateType(type: string) {
    setForm((current) => ({
      ...current,
      updateTypes: current.updateTypes.includes(type)
        ? current.updateTypes.filter((item) => item !== type)
        : [...current.updateTypes, type],
    }));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (form.updateTypes.length === 0) {
      setFormError('Select at least one update type.');
      return;
    }
    if (!form.destinationId) {
      setFormError('Select a destination.');
      return;
    }

    save.mutate({
      name: form.name.trim(),
      destinationId: form.destinationId,
      updateTypes: form.updateTypes,
      enabled: form.enabled,
      priority: Number(form.priority) || 100,
      chatIdFilter: form.chatIdFilter.trim(),
    });
  }

  const noDestinations = (destinations.data?.length ?? 0) === 0;

  return (
    <>
      {routes.error ? (
        <ErrorState
          message={
            routes.error instanceof ApiError ? routes.error.message : 'Could not load routes.'
          }
          requestId={routes.error instanceof ApiError ? routes.error.requestId : null}
        />
      ) : (
        <Card padded={false}>
          <div className="flex items-center justify-between gap-4 border-b border-border-base p-4">
            <div>
              <h2 className="text-sm font-semibold">Routes</h2>
              <p className="mt-0.5 text-xs text-text-muted">
                Every matching route receives its own copy of the update.
              </p>
            </div>
            <Button variant="primary" onClick={openCreate} disabled={noDestinations}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add route
            </Button>
          </div>

          {routes.isLoading ? (
            <TableSkeleton columns={5} />
          ) : noDestinations ? (
            <EmptyState
              icon={Send}
              title="Create a destination first"
              description="A route connects Telegram update types to a destination endpoint."
              action={
                <Link to="/admin/destinations">
                  <Button variant="primary">Go to destinations</Button>
                </Link>
              }
            />
          ) : !routes.data || routes.data.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No routes yet"
              description="Without a route, incoming updates are stored but never forwarded anywhere."
              action={
                <Button variant="primary" onClick={openCreate}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add route
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TH>Route</TH>
                <TH>Update types</TH>
                <TH>Destination</TH>
                <TH>Status</TH>
                <TH align="right">Priority</TH>
                <TH align="right" />
              </THead>
              <TBody>
                {routes.data.map((route) => (
                  <TR key={route.id}>
                    <TD>
                      <p className="font-medium">{route.name}</p>
                      {route.chatIdFilter ? (
                        <p className="text-xs text-text-faint">chat: {route.chatIdFilter}</p>
                      ) : null}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {route.updateTypes.slice(0, 3).map((type) => (
                          <Badge key={type}>{type === '*' ? 'all events' : type}</Badge>
                        ))}
                        {route.updateTypes.length > 3 ? (
                          <Badge>+{route.updateTypes.length - 3}</Badge>
                        ) : null}
                      </div>
                    </TD>
                    <TD className="max-w-56 truncate text-text-muted" title={route.destinationUrl}>
                      {route.destinationName}
                    </TD>
                    <TD>
                      <StatusBadge status={route.enabled ? 'enabled' : 'disabled'} />
                    </TD>
                    <TD align="right" className="tabular-nums text-text-muted">
                      {route.priority}
                    </TD>
                    <TD align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={test.isPending && test.variables?.id === route.id}
                          onClick={() => test.mutate(route)}
                        >
                          Send test
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openEdit(route)}>
                          Edit
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete route ${route.name}`}
                          onClick={() => setDeleteTarget(route)}
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
        title={editing ? 'Edit route' : 'New route'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeForm}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="route-form" loading={save.isPending}>
              {editing ? 'Save changes' : 'Create route'}
            </Button>
          </>
        }
      >
        <form id="route-form" onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="route-name" required>
              <Input
                id="route-name"
                required
                placeholder="Messages to worker"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>

            <Field label="Destination" htmlFor="route-destination" required>
              <Select
                id="route-destination"
                required
                value={form.destinationId}
                onChange={(event) => setForm({ ...form, destinationId: event.target.value })}
              >
                <option value="">Select a destination…</option>
                {destinations.data?.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name} — {destination.url}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Priority"
              htmlFor="route-priority"
              hint="Lower runs first when several routes match."
            >
              <Input
                id="route-priority"
                inputMode="numeric"
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value })}
              />
            </Field>

            <Field
              label="Chat ID filter"
              htmlFor="route-chat"
              hint="Optional. Comma separated; blank matches every chat."
            >
              <Input
                id="route-chat"
                placeholder="-1001234567890, 42"
                value={form.chatIdFilter}
                onChange={(event) => setForm({ ...form, chatIdFilter: event.target.value })}
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-text">Update types</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setForm({ ...form, updateTypes: ['*'] })}
                >
                  Match all
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setForm({ ...form, updateTypes: [] })}
                >
                  Clear
                </Button>
              </div>
            </div>
            <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto rounded-lg border border-border-base p-3 sm:grid-cols-3">
              <Checkbox
                label="All events (*)"
                checked={form.updateTypes.includes('*')}
                onChange={() => toggleUpdateType('*')}
              />
              {TELEGRAM_UPDATE_TYPES.map((type) => (
                <Checkbox
                  key={type}
                  label={humanizeUpdateType(type)}
                  checked={form.updateTypes.includes(type)}
                  disabled={form.updateTypes.includes('*')}
                  onChange={() => toggleUpdateType(type)}
                />
              ))}
            </div>
          </div>

          <Switch
            checked={form.enabled}
            onChange={(checked) => setForm({ ...form, enabled: checked })}
            label="Route enabled"
          />

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

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        loading={remove.isPending}
        title="Delete route"
        confirmLabel="Delete route"
        message={
          <>
            Updates matching <strong className="text-text">{deleteTarget?.name}</strong> will no
            longer be forwarded. Existing delivery history is preserved.
          </>
        }
      />
    </>
  );
}
