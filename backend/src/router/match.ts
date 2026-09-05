import { WILDCARD_UPDATE_TYPE } from '@tg-gateway/shared';

export interface MatchableRoute {
  id: string;
  enabled: boolean;
  updateTypes: string[];
  priority: number;
  chatIdFilter: string | null;
  destinationId: string;
  destinationEnabled: boolean;
}

export interface MatchInput {
  eventType: string;
  chatId: string | null;
}

/**
 * A route matches when it is enabled, its destination is enabled, its update-type list
 * contains the event type (or `*`), and any configured chat filter matches.
 *
 * `chatIdFilter` accepts a comma separated list of chat ids; an empty filter matches all.
 */
export function routeMatches(route: MatchableRoute, input: MatchInput): boolean {
  if (!route.enabled || !route.destinationEnabled) return false;

  const types = route.updateTypes;
  const typeMatches = types.includes(WILDCARD_UPDATE_TYPE) || types.includes(input.eventType);
  if (!typeMatches) return false;

  const filter = route.chatIdFilter?.trim();
  if (filter) {
    const allowed = filter
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (allowed.length > 0 && (input.chatId === null || !allowed.includes(input.chatId))) {
      return false;
    }
  }

  return true;
}

/**
 * All matching routes, ordered by ascending priority then id, so delivery order is stable
 * across restarts. Every matching route gets its own delivery.
 */
export function matchRoutes<T extends MatchableRoute>(routes: T[], input: MatchInput): T[] {
  return routes
    .filter((route) => routeMatches(route, input))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
