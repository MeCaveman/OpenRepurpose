import { Badge } from '../ui';

export interface WorkflowStatusProps {
  readonly enabled: boolean;
}

export function WorkflowStatus({ enabled }: WorkflowStatusProps) {
  return (
    <Badge variant={enabled ? 'success' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
  );
}
