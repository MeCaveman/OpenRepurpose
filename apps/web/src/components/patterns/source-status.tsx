import { Badge } from '../ui';
import type { BadgeVariant } from '../ui';

export type KnownSourceStatus = 'active' | 'paused' | 'authorization_failed';

export interface SourceStatusProps {
  readonly status: string;
}

const sourceStates: Record<
  KnownSourceStatus,
  { readonly label: string; readonly variant: BadgeVariant }
> = {
  active: { label: 'Active', variant: 'success' },
  paused: { label: 'Paused', variant: 'neutral' },
  authorization_failed: { label: 'Authorization failed', variant: 'error' },
};

export function SourceStatus({ status }: SourceStatusProps) {
  const presentation = sourceStates[status as KnownSourceStatus] ?? {
    label: status,
    variant: 'neutral' as const,
  };
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}
