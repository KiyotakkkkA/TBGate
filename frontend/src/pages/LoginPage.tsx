import { Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/surfaces';
import { Button, Field, Input } from '@/components/ui/primitives';
import { useSession } from '@/hooks/useSession';
import { ApiError } from '@/lib/api';

export function LoginPage() {
  const { user, isLoading, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isLoading && user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from.startsWith('/admin') ? from : '/admin'} replace />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const signedIn = await signIn(username.trim(), password);
      navigate(signedIn.mustChangePassword ? '/admin/change-password' : '/admin', {
        replace: true,
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Sign-in failed. Please try again in a moment.',
      );
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent shadow-sm">
            <Send className="h-5 w-5 text-accent-fg" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Telegram Gateway</h1>
          <p className="mt-1 text-sm text-text-muted">Sign in to the administration panel</p>
        </div>

        <Card className="p-5">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Username" htmlFor="username" required>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                aria-invalid={error ? true : undefined}
              />
            </Field>

            <Field label="Password" htmlFor="password" required>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
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
              Sign in
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-text-faint">
          The first administrator is created from ADMIN_USERNAME and ADMIN_PASSWORD.
        </p>
      </div>
    </div>
  );
}
