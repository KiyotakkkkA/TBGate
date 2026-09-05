import { EventsPanel } from '@/components/events/EventsPanel';
import { PageHeader } from '@/components/ui/surfaces';

export function EventsPage() {
  return (
    <>
      <PageHeader title="Events" description="Telegram updates received by this gateway" />
      <EventsPanel />
    </>
  );
}
