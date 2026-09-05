import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useSession } from '@/hooks/useSession';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { BotDetailPage } from '@/pages/BotDetailPage';
import { BotNewPage } from '@/pages/BotNewPage';
import { BotsPage } from '@/pages/BotsPage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { DeliveriesPage } from '@/pages/DeliveriesPage';
import { DestinationsPage } from '@/pages/DestinationsPage';
import { EventsPage } from '@/pages/EventsPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { UsersPage } from '@/pages/UsersPage';

function FullPageLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-text-faint" aria-label="Loading" />
    </div>
  );
}

/**
 * Auth gate. An unauthenticated visitor is sent to the sign-in page; a user whose
 * password was reset by an administrator is held on the change-password screen.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) return <FullPageLoader />;
  if (!user) return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/admin/change-password') {
    return <Navigate to="/admin/change-password" replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useSession();
  if (user && user.role !== 'admin') return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin/login" element={<LoginPage />} />
      <Route
        path="/admin/change-password"
        element={
          <RequireAuth>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="bots" element={<BotsPage />} />
        <Route path="bots/new" element={<BotNewPage />} />
        <Route path="bots/:botId" element={<BotDetailPage />} />
        <Route path="destinations" element={<DestinationsPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="deliveries" element={<DeliveriesPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route
          path="users"
          element={
            <RequireAdmin>
              <UsersPage />
            </RequireAdmin>
          }
        />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
