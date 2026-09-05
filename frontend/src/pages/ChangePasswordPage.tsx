import { ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/components/ui/feedback';
import { Button, Field, Input } from '@/components/ui/primitives';
import { Card } from '@/components/ui/surfaces';
import { useSession } from '@/hooks/useSession';
import { ApiError, api } from '@/lib/api';

export function ChangePasswordPage() {
  const { user, refresh } = useSession();
  const navigate = useNavigate();
  const toast = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const forced = user?.mustChangePassword ?? false;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword.length < 10) {
      setError('The new password must be at least 10 characters long.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/v1/auth/change-password', { currentPassword, newPassword });
      await refresh();
      toast.success('Password updated');
      navigate('/admin', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-md">
        <Card className="p-5">
          {forced ? (
            <div className="mb-4 flex gap-2.5 rounded-lg border border-warning/30 bg-warning-subtle p-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <p className="text-xs text-text">
                An administrator reset your password. Choose a new one to continue.
              </p>
            </div>
          ) : null}

          <h1 className="text-base font-semibold">Change your password</h1>
          <p className="mt-1 text-sm text-text-muted">
            Signed in as <span className="font-medium text-text">{user?.username}</span>
          </p>

          <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
            <Field label="Current password" htmlFor="current" required>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>

            <Field
              label="New password"
              htmlFor="next"
              required
              hint="At least 10 characters. Use a password manager."
            >
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>

            <Field label="Confirm new password" htmlFor="confirm" required>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </Field>

            {error ? (
              <div
                className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={submitting}
            >
              Update password
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
