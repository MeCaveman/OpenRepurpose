import {
  ResourceEmptyState,
  WorkflowCard,
  getPlatformMetadata,
  type WorkflowRouteData,
  type WorkflowRouteNodeData,
} from '../../components/patterns';
import { Alert, Badge, Button, Panel, Spinner } from '../../components/ui';
import { WorkflowEditor } from './workflow-editor';
import type { WorkflowDefinitionView, WorkflowEditorValue } from './workflow-editor';

export interface WorkflowAccountView {
  readonly displayName: string;
  readonly id: string;
  readonly provider: string;
  readonly status: string;
}

export interface WorkflowTargetView {
  readonly availability: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: string;
}

export interface WorkflowSourceView {
  readonly displayName: string;
  readonly id: string;
  readonly status: string;
}

export interface WorkflowDestinationView {
  readonly accountId: string;
  readonly destinationId: string;
  readonly [key: string]: unknown;
}

export interface WorkflowView {
  readonly definition?: WorkflowDefinitionView;
  readonly destinations: readonly WorkflowDestinationView[];
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly remoteSource?: {
    readonly connectionId: string;
    readonly retentionPolicy?: { readonly durationSeconds?: number; readonly kind: string };
  };
  readonly sourceDirectory: string;
  readonly titleTemplate: string;
}

export interface WorkflowsPageProps {
  readonly accounts: readonly WorkflowAccountView[];
  readonly error: string | undefined;
  readonly isLoading: boolean;
  readonly metaTargets: readonly WorkflowTargetView[];
  readonly onCreateWorkflow: (value: WorkflowEditorValue) => Promise<void>;
  readonly onRetry: () => void;
  readonly sources: readonly WorkflowSourceView[];
  readonly workflows: readonly WorkflowView[];
}

function toWorkflowRouteData(workflow: WorkflowView): WorkflowRouteData {
  const sourceLabel =
    workflow.sourceDirectory.trim() ||
    workflow.remoteSource?.connectionId.trim() ||
    'Remote source';
  const nodeState = workflow.enabled ? ('default' as const) : ('disabled' as const);
  const source: WorkflowRouteNodeData = {
    detail: workflow.remoteSource === undefined ? 'Watched folder' : 'Remote source',
    kind: 'source',
    label: sourceLabel,
    state: nodeState,
    ...(workflow.remoteSource === undefined ? { platform: 'local' } : {}),
  };
  const stages: WorkflowRouteNodeData[] = [];
  const destinations: WorkflowRouteNodeData[] = [];

  for (const step of workflow.definition?.steps ?? []) {
    if (step.kind === 'filter') {
      stages.push({ kind: 'filter', label: 'Filter', state: nodeState });
    } else if (step.kind === 'transform') {
      const fit = step.plan?.user.steps[0];
      stages.push({
        kind: 'transform',
        label: fit === undefined ? 'Pass-through' : `${fit.width} × ${fit.height}`,
        ...(fit === undefined ? {} : { detail: fit.mode }),
        state: nodeState,
      });
    } else if (step.kind === 'schedule') {
      stages.push({
        detail: step.scheduleId,
        kind: 'schedule',
        label: 'Schedule',
        state: nodeState,
      });
    } else if (step.kind === 'destination') {
      destinations.push({
        detail: step.destination.accountId || 'Account not selected',
        kind: 'destination',
        label: getPlatformMetadata(step.destination.destinationId).label,
        platform: step.destination.destinationId,
        state: nodeState,
      });
    }
  }

  if (destinations.length === 0) {
    destinations.push(
      ...workflow.destinations.map((destination) => ({
        detail: destination.accountId || 'Account not selected',
        kind: 'destination' as const,
        label: getPlatformMetadata(destination.destinationId).label,
        platform: destination.destinationId,
        state: nodeState,
      })),
    );
  }

  return { destinations, source, stages };
}

function LoadingWorkflows({ announce = true }: { readonly announce?: boolean }) {
  return (
    <Panel
      aria-hidden={announce ? undefined : true}
      aria-live={announce ? 'polite' : undefined}
      className="flex items-center gap-[var(--or-space-3)]"
      role={announce ? 'status' : undefined}
    >
      <Spinner />
      <p className="text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)]">
        Loading workflow routes…
      </p>
    </Panel>
  );
}

export function WorkflowsPage({
  accounts,
  error,
  isLoading,
  metaTargets,
  onCreateWorkflow,
  onRetry,
  sources,
  workflows,
}: WorkflowsPageProps) {
  return (
    <div aria-busy={isLoading || undefined} className="grid gap-[var(--or-space-8)]">
      {error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Reload workflow data
            </Button>
          }
          title="Workflow request failed"
          variant="error"
        >
          {error}
        </Alert>
      )}

      <section aria-labelledby="workflow-builder-heading">
        <header className="mb-[var(--or-space-5)]">
          <p className="font-[family-name:var(--or-font-technical)] font-semibold tracking-[var(--or-type-eyebrow-tracking)] text-[var(--or-text-accent)] uppercase [font-size:var(--or-type-eyebrow-size)] [line-height:var(--or-type-eyebrow-line)]">
            Route builder
          </p>
          <h2
            className="mt-[var(--or-space-1)] font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
            id="workflow-builder-heading"
          >
            Create a workflow
          </h2>
          <p className="mt-[var(--or-space-2)] text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
            Build one explicit route from a watched folder or authorized source to one or more
            publish targets. Meta credential identities are not publish targets.
          </p>
        </header>

        {isLoading ? (
          <LoadingWorkflows />
        ) : (
          <WorkflowEditor
            accounts={accounts}
            metaTargets={metaTargets}
            onSubmit={onCreateWorkflow}
            sources={sources}
          />
        )}
      </section>

      <section aria-labelledby="saved-workflows-heading">
        <header className="mb-[var(--or-space-4)] flex flex-wrap items-center justify-between gap-[var(--or-space-3)]">
          <div>
            <h2
              className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id="saved-workflows-heading"
            >
              Saved workflows
            </h2>
            <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
              Persisted routes compiled and validated by the application core.
            </p>
          </div>
          {!isLoading && (
            <Badge variant="neutral">
              {workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}
            </Badge>
          )}
        </header>

        {isLoading ? (
          <LoadingWorkflows announce={false} />
        ) : workflows.length === 0 ? (
          <ResourceEmptyState
            description="Create a route from a source through any processing stages to one or more destinations."
            title="No saved workflows"
          />
        ) : (
          <div className="grid gap-[var(--or-space-3)]">
            {workflows.map((workflow) => {
              const route = toWorkflowRouteData(workflow);

              return (
                <WorkflowCard
                  destinations={route.destinations}
                  enabled={workflow.enabled}
                  key={workflow.id}
                  name={workflow.name}
                  source={route.source}
                  sourceLabel={
                    workflow.sourceDirectory.trim() ||
                    workflow.remoteSource?.connectionId.trim() ||
                    'Remote source'
                  }
                  stages={route.stages ?? []}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
