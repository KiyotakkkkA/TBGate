import { TELEGRAM_UPDATE_TYPES, type BotDto } from '@tg-gateway/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Info } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '@/components/ui/feedback';
import { Button, Checkbox, Field, Input, Switch } from '@/components/ui/primitives';
import { Card, CardHeader, PageHeader } from '@/components/ui/surfaces';
import { ApiError, api } from '@/lib/api';
import { humanizeUpdateType } from '@/lib/utils';

const DEFAULT_UPDATES = ['message', 'edited_message', 'callback_query'];

export function BotNewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [allowedUpdates, setAllowedUpdates] = useState<string[]>(DEFAULT_UPDATES);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (payload: unknown) => api.post<BotDto>('/api/v1/bots', payload),
    onSuccess: async (bot) => {
      await queryClient.invalidateQueries({ queryKey: ['bots'] });
      toast.success(
        `${bot.name} added`,
        bot.webhookState === 'active'
          ? 'The Telegram webhook was registered automatically.'
          : 'Register the Telegram webhook from the bot page when you are ready.',
      );
      navigate(`/admin/bots/${bot.id}`);
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the bot.');
    },
  });

  function toggleUpdate(type: string) {
    setAllowedUpdates((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    mutation.mutate({
      name: name.trim(),
      token: token.trim(),
      enabled,
      allowedUpdates,
    });
  }

  return (
    <>
      <PageHeader
        title="Add a bot"
        description="The token is verified with Telegram getMe and encrypted before it is stored"
        actions={
          <Link to="/admin/bots">
            <Button variant="ghost">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Back
            </Button>
          </Link>
        }
      />

      <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="space-y-4">
            <CardHeader title="Bot details" />

            <Field
              label="Display name"
              htmlFor="name"
              required
              hint="Shown throughout the admin panel."
            >
              <Input
                id="name"
                required
                autoFocus
                maxLength={120}
                placeholder="Support Bot"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <Field
              label="Telegram bot token"
              htmlFor="token"
              required
              hint="From @BotFather, in the form 123456789:AA... It is encrypted with AES-256-GCM and never shown again."
            >
              <Input
                id="token"
                required
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>

            <div className="flex items-center justify-between rounded-lg border border-border-base bg-bg-subtle px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-text">Enable this bot</p>
                <p className="text-xs text-text-muted">
                  Registers the Telegram webhook immediately after the bot is created.
                </p>
              </div>
              <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
            </div>

            {error ? (
              <div
                className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-border-base pt-4">
              <Link to="/admin/bots">
                <Button variant="secondary">Cancel</Button>
              </Link>
              <Button type="submit" variant="primary" loading={mutation.isPending}>
                Verify and add bot
              </Button>
            </div>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader
            title="Update types"
            description="Which updates Telegram should send. Leave everything unchecked for Telegram's default set."
          />
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAllowedUpdates([...TELEGRAM_UPDATE_TYPES])}
            >
              Select all
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAllowedUpdates([])}>
              Clear
            </Button>
          </div>
          <div className="mt-3 max-h-96 space-y-2 overflow-y-auto pr-1">
            {TELEGRAM_UPDATE_TYPES.map((type) => (
              <Checkbox
                key={type}
                label={humanizeUpdateType(type)}
                checked={allowedUpdates.includes(type)}
                onChange={() => toggleUpdate(type)}
              />
            ))}
          </div>
          <p className="mt-3 flex gap-1.5 border-t border-border-base pt-3 text-xs text-text-faint">
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            You can change this later; the webhook is re-registered automatically.
          </p>
        </Card>
      </form>
    </>
  );
}
