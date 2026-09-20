import { PlatformIdentity } from './platform-identity';

export type WorkflowNodeKind = 'source' | 'filter' | 'transform' | 'schedule' | 'destination';
export type WorkflowNodeState =
  'default' | 'selected' | 'running' | 'completed' | 'waiting' | 'failed' | 'disabled';

export type WorkflowRouteNodeData = {
  readonly detail?: string;
  readonly kind: WorkflowNodeKind;
  readonly label: string;
  readonly platform?: string;
  readonly state?: WorkflowNodeState;
};

export type WorkflowNodeProps = WorkflowRouteNodeData;

const stateColors: Record<WorkflowNodeState, string> = {
  default: 'bg-[var(--or-route-default)]',
  selected: 'bg-[var(--or-route-selected)]',
  running: 'bg-[var(--or-route-running)]',
  completed: 'bg-[var(--or-route-completed)]',
  waiting: 'bg-[var(--or-route-waiting)]',
  failed: 'bg-[var(--or-route-failed)]',
  disabled: 'bg-[var(--or-route-disabled)]',
};

export function WorkflowNode({
  detail,
  kind,
  label,
  platform,
  state = 'default',
}: WorkflowNodeProps) {
  return (
    <article className="relative min-h-[var(--or-workflow-node-header-min-height)] w-full min-w-[var(--or-workflow-node-min-width)] max-w-[var(--or-workflow-node-max-width)] overflow-hidden rounded-[var(--or-workflow-node-radius)] border border-[var(--or-border-default)] bg-[var(--or-bg-surface-raised)] p-[var(--or-workflow-node-padding)] sm:w-[var(--or-workflow-node-width)]">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[var(--or-workflow-status-rail-width)] ${stateColors[state]}`}
      />
      <div className="flex items-center justify-between gap-[var(--or-space-2)]">
        <p className="font-semibold tracking-[var(--or-tracking-overline)] text-[var(--or-text-tertiary)] uppercase [font-size:var(--or-type-micro-size)] [line-height:var(--or-type-micro-line)]">
          {kind}
        </p>
        {state !== 'default' && (
          <span className="text-[var(--or-text-secondary)] capitalize [font-size:var(--or-type-micro-size)] [line-height:var(--or-type-micro-line)]">
            {state}
          </span>
        )}
      </div>
      <h4 className="mt-[var(--or-space-1)] break-words font-medium text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
        {label.trim() || `Unnamed ${kind}`}
      </h4>
      {platform !== undefined && (
        <span className="mt-[var(--or-space-2)] block">
          <PlatformIdentity platform={platform} size="sm" />
        </span>
      )}
      {detail !== undefined && detail.trim().length > 0 && (
        <p className="mt-[var(--or-space-2)] break-all text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
          {detail.trim()}
        </p>
      )}
    </article>
  );
}
