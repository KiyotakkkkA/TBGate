import type { SessionUserDto } from '@tg-gateway/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { ApiError, api } from '@/lib/api';

interface SessionResponse {
  user: SessionUserDto;
  csrfToken: string;
}

interface SessionContextValue {
  user: SessionUserDto | null;
  isLoading: boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  signIn: (username: string, password: string) => Promise<SessionUserDto>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * Owns "who am I". A 401 from /auth/me is a normal signed-out state, not an error,
 * so the query resolves to null instead of retrying.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const query: UseQueryResult<SessionResponse | null> = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      try {
        return await api.get<SessionResponse>('/api/v1/auth/me');
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [queryClient]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const result = await api.post<SessionResponse>('/api/v1/auth/login', {
        username,
        password,
      });
      queryClient.setQueryData(SESSION_QUERY_KEY, result);
      return result.user;
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      // Everything cached belonged to the previous session.
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(
    () => ({
      user: query.data?.user ?? null,
      isLoading: query.isLoading,
      isAdmin: query.data?.user.role === 'admin',
      refresh,
      signIn,
      signOut,
    }),
    [query.data, query.isLoading, refresh, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}
