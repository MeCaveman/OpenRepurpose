import { WorkflowNode } from './workflow-node';
import type { WorkflowRouteNodeData } from './workflow-node';

export type WorkflowRouteData = {
  readonly destinations: readonly WorkflowRouteNodeData[];
  readonly source: WorkflowRouteNodeData;
  readonly stages?: readonly WorkflowRouteNodeData[];
};

export interface WorkflowRouteProps extends WorkflowRouteData {
  readonly label?: string;
}

function RouteConnector() {
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center self-stretch text-[var(--or-route-selected)]"
    >
      <span className="h-[var(--or-space-5)] w-[var(--or-workflow-route-width)] bg-[var(--or-route-default)] sm:h-[var(--or-workflow-route-width)] sm:w-[var(--or-space-5)]" />
    </span>
  );
}

export function WorkflowRoute({
  destinations,
  label = 'Workflow route',
  source,
  stages = [],
}: WorkflowRouteProps) {
  const destinationNodes =
    destinations.length === 0
      ? [
          {
            kind: 'destination' as const,
            label: 'Destination required',
            state: 'disabled' as const,
          },
        ]
      : destinations;

  return (
    <div aria-label={label} className="overflow-x-auto" role="group">
      <div className="flex min-w-0 flex-col items-stretch gap-0 sm:min-w-max sm:flex-row sm:items-center">
        <WorkflowNode {...source} />
        {stages.map((stage, index) => (
          <div className="contents" key={`${stage.kind}-${stage.label}-${index}`}>
            <RouteConnector />
            <WorkflowNode {...stage} />
          </div>
        ))}
        <RouteConnector />
        <div
          aria-label="Destinations"
          className="relative grid gap-[var(--or-workflow-node-gap)] pl-[var(--or-space-4)] before:absolute before:inset-y-[var(--or-space-3)] before:left-0 before:w-[var(--or-workflow-route-width)] before:bg-[var(--or-route-default)] sm:pl-[var(--or-space-4)]"
          role="group"
        >
          {destinationNodes.map((destination, index) => (
            <div
              className="relative before:absolute before:top-1/2 before:right-full before:h-[var(--or-workflow-route-width)] before:w-[var(--or-space-4)] before:bg-[var(--or-route-default)]"
              key={`${destination.platform ?? 'destination'}-${destination.label}-${index}`}
            >
              <WorkflowNode {...destination} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
