import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-24 text-center">
      <p className="text-4xl font-semibold text-text-faint">404</p>
      <p className="text-sm text-text-muted">This page does not exist.</p>
      <Link
        to="/admin"
        className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
