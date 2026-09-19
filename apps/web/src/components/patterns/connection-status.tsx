import { Badge } from '../ui';
import type { BadgeVariant } from '../ui';

export type ConnectionState = 'connected' | 'connecting' | 'attention' | 'disconnected' | 'error';

export interface ConnectionStatusProps {
  readonly label?: string;
  readonly state: ConnectionState;
}

const connectionStates: Record<
  ConnectionState,
  { readonly label: string; readonly variant: BadgeVariant }
> = {
  connected: { label: 'Connected', variant: 'success' },
  connecting: { label: 'Connecting', variant: 'info' },
  attention: { label: 'Reconnect required', variant: 'warning' },
  disconnected: { label: 'Disconnected', variant: 'neutral' },
  error: { label: 'Connection error', variant: 'error' },
};

export function ConnectionStatus({ label, state }: ConnectionStatusProps) {
  const presentation = connectionStates[state];
  return <Badge variant={presentation.variant}>{label ?? presentation.label}</Badge>;
}
