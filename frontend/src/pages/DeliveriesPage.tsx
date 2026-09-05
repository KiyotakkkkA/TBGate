import { useSearchParams } from 'react-router-dom';
import { DeliveriesPanel } from '@/components/deliveries/DeliveriesPanel';
import { PageHeader } from '@/components/ui/surfaces';

export function DeliveriesPage() {
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get('status') ?? '';

  return (
    <>
      <PageHeader
        title="Deliveries"
        description="Outbound webhook requests, their responses and retry state"
      />
      {/* `key` re-mounts the panel when the deep link's status filter changes. */}
      <DeliveriesPanel key={initialStatus} initialStatus={initialStatus} />
    </>
  );
}
