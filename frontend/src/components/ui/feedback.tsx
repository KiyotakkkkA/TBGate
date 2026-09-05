import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Button } from './primitives';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-bg-subtle text-text-muted border-border-base',
  success: 'bg-success-subtle text-success border-success/30',
  warning: 'bg-warning-subtle text-warning border-warning/30',
  danger: 'bg-danger-subtle text-danger border-danger/30',
  accent: 'bg-accent-subtle text-accent border-accent/30',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
  dot,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: BadgeTone; label: string }> = {
    success: { tone: 'success', label: 'Success' },
    active: { tone: 'success', label: 'Active' },
    enabled: { tone: 'success', label: 'Enabled' },
    ok: { tone: 'success', label: 'Healthy' },
    pending: { tone: 'neutral', label: 'Pending' },
    processing: { tone: 'accent', label: 'Processing' },
    retrying: { tone: 'warning', label: 'Retrying' },
    mismatch: { tone: 'warning', label: 'URL mismatch' },
    degraded: { tone: 'warning', label: 'Degraded' },
    failed: { tone: 'danger', label: 'Failed' },
    error: { tone: 'danger', label: 'Error' },
    blocked: { tone: 'danger', label: 'Blocked' },
    disabled: { tone: 'neutral', label: 'Disabled' },
    not_configured: { tone: 'neutral', label: 'Not configured' },
    unknown: { tone: 'neutral', label: 'Unknown' },
  };
  const entry = map[status] ?? { tone: 'neutral' as BadgeTone, label: status };
  return (
    <Badge tone={entry.tone} dot>
      {entry.label}
    </Badge>
  );
}

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  description?: string;
}

interface ToastContextValue {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((tone: Toast['tone'], title: string, description?: string) => {
    const id = nextId.current++;
    setToasts((current) => [
      ...current,
      { id, tone, title, ...(description ? { description } : {}) },
    ]);
    setTimeout(
      () => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      },
      tone === 'error' ? 8000 : 4000,
    );
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (title, description) => push('success', title, description),
      error: (title, description) => push('error', title, description),
      info: (title, description) => push('info', title, description),
    }),
    [push],
  );

  const icons = { success: CheckCircle2, error: XCircle, info: Info };
  const tones = {
    success: 'border-success/40 text-success',
    error: 'border-danger/40 text-danger',
    info: 'border-accent/40 text-accent',
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-100 flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-live="polite"
      >
        {toasts.map((toast) => {
          const Icon = icons[toast.tone];
          return (
            <div
              key={toast.id}
              className={cn(
                'animate-in pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface p-3 shadow-lg',
                tones[toast.tone],
              )}
              role={toast.tone === 'error' ? 'alert' : 'status'}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-xs wrap-break-word text-text-muted">
                    {toast.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
                className="shrink-0 rounded p-0.5 text-text-faint hover:text-text"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'animate-in relative z-10 my-8 w-full rounded-card border border-border-base bg-surface shadow-xl',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-base p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-faint hover:bg-surface-hover hover:text-text"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-border-base p-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = true,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {destructive ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
        ) : null}
        <div className="text-sm text-text-muted">{message}</div>
      </div>
    </Modal>
  );
}
