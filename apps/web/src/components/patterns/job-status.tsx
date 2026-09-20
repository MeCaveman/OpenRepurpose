import { Badge } from '../ui';
import type { BadgeVariant } from '../ui';

export type KnownJobStatus =
  'pending' | 'running' | 'waiting' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

export interface JobStatusProps {
  readonly label?: string;
  readonly status: string;
}

const jobStates: Record<
  KnownJobStatus,
  { readonly label: string; readonly variant: BadgeVariant }
> = {
  pending: { label: 'Pending', variant: 'neutral' },
  running: { label: 'Running', variant: 'info' },
  waiting: { label: 'Waiting', variant: 'warning' },
  retrying: { label: 'Retrying', variant: 'warning' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'error' },
  cancelled: { label: 'Cancelled', variant: 'neutral' },
};

export function JobStatus({ label, status }: JobStatusProps) {
  const displayStatus = status.trim();
  const presentation = jobStates[displayStatus as KnownJobStatus] ?? {
    label: displayStatus.length === 0 ? 'Unknown' : displayStatus,
    variant: 'neutral' as const,
  };
  return <Badge variant={presentation.variant}>{label ?? presentation.label}</Badge>;
}
