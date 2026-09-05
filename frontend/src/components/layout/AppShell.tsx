import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Radio,
  Send,
  Settings as SettingsIcon,
  Sun,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/hooks/useSession';
import { useTheme } from '@/hooks/useTheme';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/feedback';
import { Button } from '@/components/ui/primitives';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/bots', label: 'Bots', icon: Bot },
  { to: '/admin/destinations', label: 'Destinations', icon: Send },
  { to: '/admin/events', label: 'Events', icon: Radio },
  { to: '/admin/deliveries', label: 'Deliveries', icon: Activity },
  { to: '/admin/api-keys', label: 'API keys', icon: KeyRound },
  { to: '/admin/users', label: 'Users', icon: Users, adminOnly: true },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

function HealthPill() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<{ status: string; version: string }>('/api/v1/health'),
    refetchInterval: 30_000,
    retry: false,
  });

  if (!data) {
    return (
      <Badge tone="warning" dot>
        Connecting
      </Badge>
    );
  }
  return (
    <Badge tone="success" dot>
      Online · v{data.version}
    </Badge>
  );
}

export function AppShell() {
  const { user, signOut } = useSession();
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const visibleItems = NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === 'admin');

  const nav = (
    <nav className="flex-1 space-y-0.5 px-2 py-3" aria-label="Main">
      {visibleItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent-subtle text-accent'
                : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )
          }
        >
          <item.icon className="h-4 w-4 shrink-0" aria-hidden />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border-base bg-surface lg:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-border-base px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent">
            <Send className="h-3.5 w-3.5 text-accent-fg" aria-hidden />
          </div>
          <span className="text-sm font-semibold tracking-tight">Telegram Gateway</span>
        </div>
        {nav}
        <div className="border-t border-border-base p-3 text-[11px] text-text-faint">
          Signed in as <span className="font-medium text-text-muted">{user?.username ?? '—'}</span>
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="animate-in relative flex h-full w-64 flex-col border-r border-border-base bg-surface">
            <div className="flex h-14 items-center justify-between border-b border-border-base px-4">
              <span className="text-sm font-semibold">Telegram Gateway</span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {nav}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-base bg-surface px-4">
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </Button>
            <HealthPill />
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>

            <div className="hidden items-center gap-2 sm:flex">
              <div className="text-right leading-tight">
                <p className="text-xs font-medium text-text">
                  {user?.displayName || user?.username}
                </p>
                <p className="text-[11px] text-text-faint capitalize">{user?.role}</p>
              </div>
            </div>

            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
