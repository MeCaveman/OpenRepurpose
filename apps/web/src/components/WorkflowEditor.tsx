import { useMemo, useState } from 'react';

import { Alert, Badge, Button, Checkbox, FormField, Input, Panel, Select, Textarea } from './ui';

export type WorkflowDefinitionView = {
  schemaVersion: 1;
  steps: readonly WorkflowStepView[];
  edges: readonly { from: string; to: string }[];
};

type WorkflowStepView =
  | { id: string; kind: 'source'; sourceType: 'remote' | 'watched_folder' }
  | { id: string; kind: 'filter'; filters: Record<string, unknown> }
  | { id: string; kind: 'transform'; operation: 'pass_through' }
  | { id: string; kind: 'schedule'; scheduleId: string }
  | { id: string; kind: 'destination'; destination: WorkflowDestinationView };

export type WorkflowDestinationView = {
  accountId: string;
  destinationId: 'youtube' | 'tiktok' | 'instagram' | 'facebook';
  privacy?: 'private' | 'public' | 'unlisted';
  privacyLevel?: string;
};

export type WorkflowEditorValue = {
  name: string;
  sourceDirectory?: string;
  remoteSource?: {
    connectionId: string;
    filters?: Record<string, unknown>;
    retentionPolicy?: { kind: string; durationSeconds?: number };
    rightsConfirmed: boolean;
  };
  titleTemplate: string;
  descriptionTemplate: string;
  destinations: readonly WorkflowDestinationView[];
  definition: WorkflowDefinitionView;
  enabled: boolean;
};

type AccountOption = { id: string; displayName: string; provider: string; status: string };
type TargetOption = {
  id: string;
  displayName: string;
  kind: string;
  enabled: boolean;
  availability: string;
};
type SourceOption = { id: string; displayName: string; status: string };

export function WorkflowEditor({
  accounts,
  metaTargets,
  sources,
  onSubmit,
}: {
  accounts: readonly AccountOption[];
  metaTargets: readonly TargetOption[];
  sources: readonly SourceOption[];
  onSubmit: (value: WorkflowEditorValue) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [sourceDirectory, setSourceDirectory] = useState('');
  const [remoteSourceId, setRemoteSourceId] = useState('');
  const [retention, setRetention] = useState('delete_after_success');
  const [retentionHours, setRetentionHours] = useState('24');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [titleTemplate, setTitleTemplate] = useState('{{file.stem}}');
  const [descriptionTemplate, setDescriptionTemplate] = useState('');
  const [filterTitle, setFilterTitle] = useState('');
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [transformEnabled, setTransformEnabled] = useState(false);
  const [scheduleId, setScheduleId] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [destinations, setDestinations] = useState<WorkflowDestinationView[]>([]);
  const [validationError, setValidationError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const targetOptions = useMemo(
    () => [
      ...accounts
        .filter((account) => account.status === 'connected')
        .map((account) => ({
          value: `${account.provider}:${account.id}`,
          label: `${account.displayName} · ${account.provider}`,
          disabled: false,
        })),
      ...metaTargets.map((target) => ({
        value: `${target.kind === 'instagram_professional' ? 'instagram' : 'facebook'}:${target.id}`,
        label: `${target.displayName} · ${target.kind === 'instagram_professional' ? 'Instagram' : 'Facebook Page'}`,
        disabled: target.availability !== 'available' || !target.enabled,
      })),
    ],
    [accounts, metaTargets],
  );

  const addDestination = () =>
    setDestinations((current) => [
      ...current,
      { destinationId: 'youtube', accountId: '', privacy: 'private' },
    ]);
  const updateDestination = (index: number, value: string) => {
    const [destinationId, accountId = ''] = value.split(':', 2) as [
      WorkflowDestinationView['destinationId'],
      string?,
    ];
    setDestinations((current) =>
      current.map((destination, position) =>
        position === index
          ? destinationId === 'youtube'
            ? { destinationId, accountId, privacy: 'private' }
            : destinationId === 'tiktok'
              ? { destinationId, accountId, privacyLevel: 'SELF_ONLY' }
              : { destinationId, accountId }
          : destination,
      ),
    );
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(undefined);
    if (name.trim().length === 0) return setValidationError('Give this workflow a name.');
    if (remoteSourceId.length === 0 && sourceDirectory.trim().length === 0)
      return setValidationError('Choose a watched folder or a remote source.');
    if (
      destinations.length === 0 ||
      destinations.some((destination) => destination.accountId.trim().length === 0)
    )
      return setValidationError('Add at least one complete destination.');
    if (scheduleEnabled && scheduleId.trim().length === 0)
      return setValidationError('Enter the schedule ID for the schedule step.');
    const sourceType =
      remoteSourceId.length === 0 ? ('watched_folder' as const) : ('remote' as const);
    const filter =
      remoteSourceId.length > 0 && filterEnabled && filterTitle.trim().length > 0
        ? { id: 'filter', kind: 'filter' as const, filters: { titleContains: filterTitle.trim() } }
        : undefined;
    const schedule = scheduleEnabled
      ? { id: 'schedule', kind: 'schedule' as const, scheduleId: scheduleId.trim() }
      : undefined;
    const steps: WorkflowStepView[] = [
      { id: 'source', kind: 'source', sourceType },
      ...(filter === undefined ? [] : [filter]),
      ...(transformEnabled
        ? [{ id: 'transform', kind: 'transform' as const, operation: 'pass_through' as const }]
        : []),
      ...(schedule === undefined ? [] : [schedule]),
      ...destinations.map((destination, index) => ({
        id: `destination-${index + 1}`,
        kind: 'destination' as const,
        destination,
      })),
    ];
    const chain = [
      'source',
      ...(filter === undefined ? [] : ['filter']),
      ...(transformEnabled ? ['transform'] : []),
      ...(schedule === undefined ? [] : ['schedule']),
    ];
    const edges = [
      ...chain.slice(0, -1).map((from, index) => ({ from, to: chain[index + 1]! })),
      ...destinations.map((_, index) => ({
        from: chain[chain.length - 1]!,
        to: `destination-${index + 1}`,
      })),
    ];
    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        ...(remoteSourceId.length === 0
          ? { sourceDirectory: sourceDirectory.trim() }
          : {
              remoteSource: {
                connectionId: remoteSourceId,
                retentionPolicy: {
                  kind: retention,
                  ...(retention === 'keep_for_duration'
                    ? { durationSeconds: Number(retentionHours) * 3600 }
                    : {}),
                },
                rightsConfirmed,
                ...(filter === undefined ? {} : { filters: filter.filters }),
              },
            }),
        titleTemplate,
        descriptionTemplate,
        destinations,
        definition: { schemaVersion: 1, steps, edges },
        enabled: true,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      className="mt-[var(--or-space-5)] grid gap-[var(--or-field-group-gap-setup)]"
      onSubmit={submit}
    >
      {validationError !== undefined && (
        <Alert title="Workflow needs attention" variant="error">
          {validationError}
        </Alert>
      )}
      <FormField label="Workflow name" required>
        <Input onChange={(event) => setName(event.target.value)} value={name} />
      </FormField>
      <Panel className="grid gap-[var(--or-space-3)]">
        <div>
          <h3 className="font-medium text-[var(--or-text-primary)]">1 · Source</h3>
          <p className="mt-1 text-xs text-[var(--or-text-tertiary)]">
            Start with local files or an authorized source connection.
          </p>
        </div>
        <FormField label="Source type">
          <Select
            value={remoteSourceId}
            onChange={(event) => setRemoteSourceId(event.target.value)}
          >
            <option value="">Watched folder</option>
            {sources
              .filter((source) => source.status === 'active')
              .map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
          </Select>
        </FormField>
        {remoteSourceId.length === 0 ? (
          <FormField label="Watched folder" required>
            <Input
              onChange={(event) => setSourceDirectory(event.target.value)}
              placeholder="C:\\Media\\watched"
              value={sourceDirectory}
            />
          </FormField>
        ) : (
          <>
            <FormField label="Source retention">
              <Select value={retention} onChange={(event) => setRetention(event.target.value)}>
                <option value="delete_after_success">Delete after destinations succeed</option>
                <option value="keep_for_duration">Keep for a duration</option>
                <option value="keep_forever">Keep forever</option>
              </Select>
            </FormField>
            {retention === 'keep_for_duration' && (
              <FormField label="Retention hours" required>
                <Input
                  min="1"
                  type="number"
                  value={retentionHours}
                  onChange={(event) => setRetentionHours(event.target.value)}
                />
              </FormField>
            )}
            <Checkbox
              checked={rightsConfirmed}
              label="I own this source media or am authorized to reuse it."
              onChange={(event) => setRightsConfirmed(event.target.checked)}
            />
          </>
        )}
      </Panel>
      <Panel className="grid gap-[var(--or-space-3)]">
        <div>
          <h3 className="font-medium text-[var(--or-text-primary)]">
            2 · Filter{' '}
            <span className="text-xs font-normal text-[var(--or-text-tertiary)]">optional</span>
          </h3>
          <p className="mt-1 text-xs text-[var(--or-text-tertiary)]">
            Only remote sources can use a title filter in v0.5.
          </p>
        </div>
        <Checkbox
          checked={filterEnabled}
          disabled={remoteSourceId.length === 0}
          label="Enable title filter"
          onChange={(event) => setFilterEnabled(event.target.checked)}
        />
        {filterEnabled && (
          <FormField label="Title contains">
            <Input
              onChange={(event) => setFilterTitle(event.target.value)}
              placeholder="Text to match"
              value={filterTitle}
            />
          </FormField>
        )}
      </Panel>
      <Panel className="grid gap-[var(--or-space-3)]">
        <div>
          <h3 className="font-medium text-[var(--or-text-primary)]">
            3 · Schedule{' '}
            <span className="text-xs font-normal text-[var(--or-text-tertiary)]">optional</span>
          </h3>
          <p className="mt-1 text-xs text-[var(--or-text-tertiary)]">
            Attach an existing durable schedule by ID. Timing and timezone remain owned by the
            scheduler.
          </p>
        </div>
        <Checkbox
          checked={scheduleEnabled}
          label="Hold this workflow at a schedule boundary"
          onChange={(event) => setScheduleEnabled(event.target.checked)}
        />
        {scheduleEnabled && (
          <FormField label="Schedule ID" required>
            <Input onChange={(event) => setScheduleId(event.target.value)} value={scheduleId} />
          </FormField>
        )}
      </Panel>
      <Panel className="grid gap-[var(--or-space-3)]">
        <div>
          <h3 className="font-medium text-[var(--or-text-primary)]">
            Transform{' '}
            <span className="text-xs font-normal text-[var(--or-text-tertiary)]">placeholder</span>
          </h3>
          <p className="mt-1 text-xs text-[var(--or-text-tertiary)]">
            v0.5 stores a pass-through transform boundary; media operations arrive in v0.6.
          </p>
        </div>
        <Checkbox
          checked={transformEnabled}
          label="Include pass-through transform step"
          onChange={(event) => setTransformEnabled(event.target.checked)}
        />
      </Panel>
      <Panel className="grid gap-[var(--or-space-3)]">
        <div>
          <h3 className="font-medium text-[var(--or-text-primary)]">4 · Destinations</h3>
          <p className="mt-1 text-xs text-[var(--or-text-tertiary)]">
            Each destination is explicit; unavailable Meta targets stay visible instead of being
            silently replaced.
          </p>
        </div>
        {destinations.map((destination, index) => (
          <div className="flex gap-2" key={index}>
            <Select
              aria-label={`Destination ${index + 1}`}
              className="min-w-0 flex-1"
              value={`${destination.destinationId}:${destination.accountId}`}
              onChange={(event) => updateDestination(index, event.target.value)}
            >
              <option value="">Select a publish target</option>
              {targetOptions.map((option) => (
                <option disabled={option.disabled} key={option.value} value={option.value}>
                  {option.label}
                  {option.disabled ? ' · unavailable' : ''}
                </option>
              ))}
            </Select>
            <Button
              onClick={() =>
                setDestinations((current) => current.filter((_, position) => position !== index))
              }
              size="sm"
              variant="ghost"
            >
              Remove
            </Button>
          </div>
        ))}
        <Button className="w-fit" onClick={addDestination}>
          + Add destination
        </Button>
      </Panel>
      <Panel className="grid gap-[var(--or-space-3)]" surface="inset">
        <h3 className="font-medium">Metadata templates</h3>
        <FormField label="Title template" required>
          <Input onChange={(event) => setTitleTemplate(event.target.value)} value={titleTemplate} />
        </FormField>
        <FormField label="Description template">
          <Textarea
            onChange={(event) => setDescriptionTemplate(event.target.value)}
            value={descriptionTemplate}
          />
        </FormField>
      </Panel>
      <Panel>
        <h3 className="font-medium">Readable workflow summary</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {[
            'Source',
            ...(filterEnabled ? ['Filter'] : []),
            ...(transformEnabled ? ['Transform'] : []),
            ...(scheduleEnabled ? ['Schedule'] : []),
            ...(destinations.length === 0
              ? ['Destination']
              : destinations.map((_, index) => `Destination ${index + 1}`)),
          ].map((label, index, all) => (
            <span className="flex items-center gap-2" key={label}>
              <Badge>{label}</Badge>
              {index < all.length - 1 && (
                <span aria-hidden="true" className="text-[var(--or-route-default)]">
                  →
                </span>
              )}
            </span>
          ))}
        </div>
        <p className="mt-3 text-xs text-[var(--or-text-tertiary)]">
          The saved definition is compiled and validated by the application core before persistence.
        </p>
      </Panel>
      <div className="flex items-center gap-3">
        <Button
          isLoading={isSubmitting}
          loadingLabel="Saving workflow"
          type="submit"
          variant="primary"
        >
          Save workflow
        </Button>
        <span className="text-xs text-[var(--or-text-tertiary)]">
          Invalid or disconnected graphs are rejected by the core.
        </span>
      </div>
    </form>
  );
}
