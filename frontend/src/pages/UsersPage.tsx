import type { UserDto } from '@tg-gateway/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, ConfirmDialog, Modal, StatusBadge, useToast } from '@/components/ui/feedback';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { Card, EmptyState, ErrorState, PageHeader } from '@/components/ui/surfaces';
import { TBody, TD, TH, THead, TR, Table, TableSkeleton } from '@/components/ui/table';
import { useSession } from '@/hooks/useSession';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/utils';

export function UsersPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user: currentUser } = useSession();

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    username: '',
    password: '',
    displayName: '',
    role: 'manager',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<UserDto | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<UserDto | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserDto[]>('/api/v1/users'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const create = useMutation({
    mutationFn: (payload: unknown) => api.post<UserDto>('/api/v1/users', payload),
    onSuccess: async () => {
      await invalidate();
      toast.success('User created');
      setCreating(false);
      setForm({ username: '', password: '', displayName: '', role: 'manager' });
    },
    onError: (caught) => {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not create the user.');
    },
  });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      api.patch<UserDto>(`/api/v1/users/${id}`, payload),
    onSuccess: async () => {
      await invalidate();
      toast.success('User updated');
    },
    onError: (caught) => {
      toast.error('Could not update user', caught instanceof ApiError ? caught.message : undefined);
    },
  });

  const reset = useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      api.post(`/api/v1/users/${id}/reset-password`, { newPassword }),
    onSuccess: async () => {
      await invalidate();
      toast.success(
        'Password reset',
        'The user must choose a new password the next time they sign in. All their sessions were ended.',
      );
      setResetTarget(null);
      setResetPassword('');
    },
    onError: (caught) => {
      toast.error(
        'Could not reset password',
        caught instanceof ApiError ? caught.message : undefined,
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/users/${id}`),
    onSuccess: async () => {
      await invalidate();
      toast.success('User deleted');
      setDeleteTarget(null);
    },
    onError: (caught) => {
      toast.error('Could not delete user', caught instanceof ApiError ? caught.message : undefined);
      setDeleteTarget(null);
    },
  });

  function onCreate(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (form.password.length < 10) {
      setFormError('The password must be at least 10 characters long.');
      return;
    }
    create.mutate({
      username: form.username.trim().toLowerCase(),
      password: form.password,
      role: form.role,
      ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
    });
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Administrators manage everything; managers only see the bots they own"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setFormError(null);
              setCreating(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add user
          </Button>
        }
      />

      {error ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load users.'}
          requestId={error instanceof ApiError ? error.requestId : null}
        />
      ) : (
        <Card padded={false}>
          {isLoading ? (
            <TableSkeleton columns={6} />
          ) : !data || data.length === 0 ? (
            <EmptyState icon={Users} title="No users" />
          ) : (
            <Table>
              <THead>
                <TH>User</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH align="right">Bots</TH>
                <TH align="right">Last sign-in</TH>
                <TH align="right">Created</TH>
                <TH align="right" />
              </THead>
              <TBody>
                {data.map((user) => {
                  const isSelf = user.id === currentUser?.id;
                  return (
                    <TR key={user.id}>
                      <TD>
                        <div className="flex items-center gap-2">
                          <div>
                            <p className="font-medium">{user.username}</p>
                            {user.displayName ? (
                              <p className="text-xs text-text-faint">{user.displayName}</p>
                            ) : null}
                          </div>
                          {isSelf ? <Badge tone="accent">you</Badge> : null}
                          {user.mustChangePassword ? (
                            <Badge tone="warning">password reset</Badge>
                          ) : null}
                        </div>
                      </TD>
                      <TD>
                        <Select
                          className="h-8 w-32 text-xs"
                          value={user.role}
                          disabled={isSelf}
                          onChange={(event) =>
                            update.mutate({ id: user.id, payload: { role: event.target.value } })
                          }
                          aria-label={`Role for ${user.username}`}
                        >
                          <option value="admin">Admin</option>
                          <option value="manager">Manager</option>
                        </Select>
                      </TD>
                      <TD>
                        <StatusBadge status={user.status} />
                      </TD>
                      <TD align="right" className="tabular-nums text-text-muted">
                        {user.botCount}
                      </TD>
                      <TD align="right" className="whitespace-nowrap text-text-faint">
                        {formatRelative(user.lastLoginAt)}
                      </TD>
                      <TD align="right" className="whitespace-nowrap text-text-faint">
                        {formatDateTime(user.createdAt)}
                      </TD>
                      <TD align="right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isSelf}
                            onClick={() =>
                              update.mutate({
                                id: user.id,
                                payload: {
                                  status: user.status === 'blocked' ? 'active' : 'blocked',
                                },
                              })
                            }
                          >
                            {user.status === 'blocked' ? 'Unblock' : 'Block'}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Reset password"
                            aria-label={`Reset password for ${user.username}`}
                            onClick={() => {
                              setResetPassword('');
                              setResetTarget(user);
                            }}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={isSelf}
                            title="Delete user"
                            aria-label={`Delete ${user.username}`}
                            onClick={() => setDeleteTarget(user)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-danger" />
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Add user"
        description="Managers can create bots, destinations and routes, but only see their own."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="user-form" loading={create.isPending}>
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              Create user
            </Button>
          </>
        }
      >
        <form id="user-form" onSubmit={onCreate} className="space-y-4" noValidate>
          <Field
            label="Username"
            htmlFor="user-username"
            required
            hint="Letters, digits, dot, underscore, hyphen."
          >
            <Input
              id="user-username"
              required
              autoFocus
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
            />
          </Field>

          <Field label="Display name" htmlFor="user-display">
            <Input
              id="user-display"
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            />
          </Field>

          <Field
            label="Initial password"
            htmlFor="user-password"
            required
            hint="At least 10 characters. Share it over a secure channel."
          >
            <Input
              id="user-password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </Field>

          <Field label="Role" htmlFor="user-role">
            <Select
              id="user-role"
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value })}
            >
              <option value="manager">Manager — own bots and routes only</option>
              <option value="admin">Admin — full access, including users</option>
            </Select>
          </Field>

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
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        title={`Reset password for ${resetTarget?.username ?? ''}`}
        description="The user is signed out everywhere and must choose a new password on next sign-in."
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={reset.isPending}
              disabled={resetPassword.length < 10}
              onClick={() =>
                resetTarget && reset.mutate({ id: resetTarget.id, newPassword: resetPassword })
              }
            >
              Reset password
            </Button>
          </>
        }
      >
        <Field
          label="Temporary password"
          htmlFor="reset-password"
          required
          hint="At least 10 characters."
        >
          <Input
            id="reset-password"
            type="text"
            autoComplete="off"
            value={resetPassword}
            onChange={(event) => setResetPassword(event.target.value)}
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        loading={remove.isPending}
        title="Delete user"
        confirmLabel="Delete user"
        message={
          <>
            <strong className="text-text">{deleteTarget?.username}</strong> will be removed and
            signed out. Their {deleteTarget?.botCount ?? 0} bot(s) stay in place but become
            unassigned, and remain visible to administrators.
          </>
        }
      />
    </>
  );
}
