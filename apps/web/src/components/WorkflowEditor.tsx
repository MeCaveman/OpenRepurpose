import { useMemo, useState } from 'react';

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
  };

  return (
    <form className="mt-5 grid gap-5" onSubmit={submit}>
      {validationError !== undefined && (
        <p className="rounded-lg border border-rose-300/30 bg-rose-950/30 p-3 text-sm text-rose-200">
          {validationError}
        </p>
      )}
      <label className="grid gap-1 text-sm">
        <span className="text-slate-300">Workflow name</span>
        <input
          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
      </label>
      <section className="grid gap-3 rounded-lg border border-cyan-300/20 bg-cyan-950/10 p-4">
        <div>
          <h3 className="font-medium text-cyan-100">1 · Source</h3>
          <p className="mt-1 text-xs text-slate-400">
            Start with local files or an authorized source connection.
          </p>
        </div>
        <select
          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm"
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
        </select>
        {remoteSourceId.length === 0 ? (
          <input
            className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm"
            onChange={(event) => setSourceDirectory(event.target.value)}
            placeholder="C:\\Media\\watched"
            required
            value={sourceDirectory}
          />
        ) : (
          <>
            <select
              className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm"
              value={retention}
              onChange={(event) => setRetention(event.target.value)}
            >
              <option value="delete_after_success">Delete after destinations succeed</option>
              <option value="keep_for_duration">Keep for a duration</option>
              <option value="keep_forever">Keep forever</option>
            </select>
            {retention === 'keep_for_duration' && (
              <input
                className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm"
                min="1"
                type="number"
                value={retentionHours}
                onChange={(event) => setRetentionHours(event.target.value)}
              />
            )}
            <label className="flex gap-2 text-sm text-amber-100">
              <input
                checked={rightsConfirmed}
                onChange={(event) => setRightsConfirmed(event.target.checked)}
                type="checkbox"
              />
              I own this source media or am authorized to reuse it.
            </label>
          </>
        )}
      </section>
      <section className="grid gap-3 rounded-lg border border-violet-300/20 bg-violet-950/10 p-4">
        <div>
          <h3 className="font-medium text-violet-100">
            2 · Filter <span className="text-xs font-normal text-slate-400">optional</span>
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Only remote sources can use a title filter in v0.5.
          </p>
        </div>
        <label className="flex gap-2 text-sm">
          <input
            checked={filterEnabled}
            disabled={remoteSourceId.length === 0}
            onChange={(event) => setFilterEnabled(event.target.checked)}
            type="checkbox"
          />
          Enable title filter
        </label>
        {filterEnabled && (
          <input
            className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm"
            onChange={(event) => setFilterTitle(event.target.value)}
            placeholder="Title contains…"
            value={filterTitle}
          />
        )}
      </section>
      <section className="grid gap-3 rounded-lg border border-amber-300/20 bg-amber-950/10 p-4">
        <div>
          <h3 className="font-medium text-amber-100">
            3 · Schedule <span className="text-xs font-normal text-slate-400">optional</span>
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Attach an existing durable schedule by ID. Timing and timezone remain owned by the
            scheduler.
          </p>
        </div>
        <label className="flex gap-2 text-sm">
          <input
            checked={scheduleEnabled}
            onChange={(event) => setScheduleEnabled(event.target.checked)}
            type="checkbox"
          />
          Hold this workflow at a schedule boundary
        </label>
        {scheduleEnabled && (
          <input
            className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm"
            onChange={(event) => setScheduleId(event.target.value)}
            placeholder="Schedule ID"
            value={scheduleId}
          />
        )}
      </section>
      <section className="grid gap-3 rounded-lg border border-fuchsia-300/20 bg-fuchsia-950/10 p-4">
        <div>
          <h3 className="font-medium text-fuchsia-100">
            Transform <span className="text-xs font-normal text-slate-400">placeholder</span>
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            v0.5 stores a pass-through transform boundary; media operations arrive in v0.6.
          </p>
        </div>
        <label className="flex gap-2 text-sm">
          <input
            checked={transformEnabled}
            onChange={(event) => setTransformEnabled(event.target.checked)}
            type="checkbox"
          />
          Include pass-through transform step
        </label>
      </section>
      <section className="grid gap-3 rounded-lg border border-emerald-300/20 bg-emerald-950/10 p-4">
        <div>
          <h3 className="font-medium text-emerald-100">4 · Destinations</h3>
          <p className="mt-1 text-xs text-slate-400">
            Each destination is explicit; unavailable Meta targets stay visible instead of being
            silently replaced.
          </p>
        </div>
        {destinations.map((destination, index) => (
          <div className="flex gap-2" key={index}>
            <select
              className="min-w-0 flex-1 rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm"
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
            </select>
            <button
              className="rounded-lg border border-white/15 px-3 text-sm text-slate-300"
              onClick={() =>
                setDestinations((current) => current.filter((_, position) => position !== index))
              }
              type="button"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="w-fit rounded-lg border border-emerald-300/30 px-3 py-2 text-sm text-emerald-100"
          onClick={addDestination}
          type="button"
        >
          + Add destination
        </button>
      </section>
      <section className="grid gap-3 rounded-lg border border-white/10 bg-slate-950/60 p-4">
        <h3 className="font-medium">Metadata templates</h3>
        <label className="grid gap-1 text-sm">
          <span className="text-slate-300">Title template</span>
          <input
            className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
            onChange={(event) => setTitleTemplate(event.target.value)}
            required
            value={titleTemplate}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-slate-300">Description template</span>
          <textarea
            className="rounded-lg border border-white/15 bg-slate-900 px-3 py-2"
            onChange={(event) => setDescriptionTemplate(event.target.value)}
            value={descriptionTemplate}
          />
        </label>
      </section>
      <section className="rounded-lg border border-white/10 bg-slate-900/50 p-4">
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
              <span className="rounded-full border border-white/15 bg-slate-950 px-3 py-1.5">
                {label}
              </span>
              {index < all.length - 1 && <span className="text-slate-500">→</span>}
            </span>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          The saved definition is compiled and validated by the application core before persistence.
        </p>
      </section>
      <div className="flex items-center gap-3">
        <button
          className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
          type="submit"
        >
          Save workflow
        </button>
        <span className="text-xs text-slate-500">
          Invalid or disconnected graphs are rejected by the core.
        </span>
      </div>
    </form>
  );
}
