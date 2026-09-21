import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { ResourceEmptyState } from '../../components/patterns';
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  Panel,
  Spinner,
  Textarea,
} from '../../components/ui';

export type SubtitleFormat = 'srt' | 'vtt';

export interface TranscriptCueView {
  readonly endMs: number;
  readonly startMs: number;
  readonly text: string;
  readonly words?: readonly {
    readonly endMs: number;
    readonly startMs: number;
    readonly text: string;
  }[];
}

export interface TranscriptView {
  readonly cues: readonly TranscriptCueView[];
  readonly hasUserEdits: boolean;
  readonly id: string;
  readonly language?: string;
  readonly model: { readonly id: string; readonly version: string };
  readonly providerId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface TranscriptWorkspaceView {
  readonly assetPath: string;
  readonly error?: string;
  readonly exportingFormat?: SubtitleFormat;
  readonly isLoading: boolean;
  readonly isSaving: boolean;
  readonly mediaId: string;
  readonly notice?: string;
  readonly transcript?: TranscriptView;
}

export interface TranscriptEditorProps {
  readonly onClose: () => void;
  readonly onDirtyChange: (isDirty: boolean) => void;
  readonly onExport: (format: SubtitleFormat) => void;
  readonly onRetry: () => void;
  readonly onSave: (cues: readonly TranscriptCueView[], expectedRevision: number) => void;
  readonly workspace: TranscriptWorkspaceView;
}

interface DraftCue {
  readonly end: string;
  readonly start: string;
  readonly text: string;
  readonly words?: TranscriptCueView['words'];
}

const pageSize = 6;
const timestampPattern = /^(\d{2,}):([0-5]\d):([0-5]\d)[.,](\d{3})$/;

function timestampFromMilliseconds(value: number): string {
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const milliseconds = value % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function millisecondsFromTimestamp(value: string): number | undefined {
  const match = timestampPattern.exec(value.trim());
  if (match === null) return undefined;
  const result =
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1_000 +
    Number(match[4]);
  return Number.isSafeInteger(result) ? result : undefined;
}

function draftFromTranscript(transcript: TranscriptView | undefined): readonly DraftCue[] {
  return (
    transcript?.cues.map((cue) => ({
      end: timestampFromMilliseconds(cue.endMs),
      start: timestampFromMilliseconds(cue.startMs),
      text: cue.text,
      ...(cue.words === undefined ? {} : { words: cue.words }),
    })) ?? []
  );
}

function validateDraft(draft: readonly DraftCue[]): {
  readonly cues?: readonly TranscriptCueView[];
  readonly errors: Readonly<Record<string, string>>;
} {
  const errors: Record<string, string> = {};
  const cues: TranscriptCueView[] = [];
  let previousStart: number | undefined;
  draft.forEach((cue, index) => {
    const startMs = millisecondsFromTimestamp(cue.start);
    const endMs = millisecondsFromTimestamp(cue.end);
    if (startMs === undefined)
      errors[`${index}.start`] = 'Use HH:MM:SS.mmm, for example 00:01:24.500.';
    if (endMs === undefined) errors[`${index}.end`] = 'Use HH:MM:SS.mmm, for example 00:01:27.000.';
    if (startMs !== undefined && endMs !== undefined && endMs <= startMs)
      errors[`${index}.end`] = 'End time must be later than start time.';
    if (startMs !== undefined && previousStart !== undefined && startMs < previousStart)
      errors[`${index}.start`] = 'Cue start times must stay in chronological order.';
    const text = cue.text.trim();
    if (text.length === 0) errors[`${index}.text`] = 'Cue text cannot be empty.';
    if (text.length > 20_000)
      errors[`${index}.text`] = 'Cue text must be 20,000 characters or fewer.';
    if (startMs !== undefined) previousStart = startMs;
    if (startMs !== undefined && endMs !== undefined && endMs > startMs && text.length > 0)
      cues.push({
        startMs,
        endMs,
        text,
        ...(cue.words === undefined ? {} : { words: cue.words }),
      });
  });
  return Object.keys(errors).length === 0 ? { cues, errors } : { errors };
}

function filename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || 'Unnamed media file';
}

export function TranscriptEditor({
  onClose,
  onDirtyChange,
  onExport,
  onRetry,
  onSave,
  workspace,
}: TranscriptEditorProps) {
  const [draft, setDraft] = useState<readonly DraftCue[]>(() =>
    draftFromTranscript(workspace.transcript),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [page, setPage] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setDraft(draftFromTranscript(workspace.transcript));
    setErrors({});
    setIsDirty(false);
    setPage(0);
  }, [workspace.transcript?.id, workspace.transcript?.revision]);

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    requestAnimationFrame(() => headingRef.current?.focus());
  }, [workspace.mediaId]);

  const pageCount = Math.max(1, Math.ceil(draft.length / pageSize));
  const visibleDraft = useMemo(
    () => draft.slice(page * pageSize, (page + 1) * pageSize),
    [draft, page],
  );

  const updateCue = (index: number, field: 'end' | 'start' | 'text', value: string) => {
    setDraft((current) =>
      current.map((cue, cueIndex) =>
        cueIndex === index
          ? { end: cue.end, start: cue.start, text: cue.text, [field]: value }
          : cue,
      ),
    );
    setErrors((current) => {
      const next = { ...current };
      delete next[`${index}.${field}`];
      return next;
    });
    setIsDirty(true);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateDraft(draft);
    setErrors(result.errors);
    if (result.cues === undefined || workspace.transcript === undefined) {
      const firstKey = Object.keys(result.errors)[0];
      if (firstKey !== undefined) {
        const cueIndex = Number(firstKey.split('.')[0]);
        setPage(Math.floor(cueIndex / pageSize));
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(`[data-transcript-field="${firstKey}"]`)?.focus(),
        );
      }
      return;
    }
    onSave(result.cues, workspace.transcript.revision);
  };

  const submitShortcut = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };

  const transcript = workspace.transcript;
  const exportDisabled =
    transcript === undefined || draft.length === 0 || isDirty || workspace.isSaving;
  const exportHelpId = 'transcript-export-help';

  return (
    <Panel
      aria-labelledby="transcript-editor-heading"
      className="min-[90rem]:sticky min-[90rem]:top-[var(--or-space-4)]"
      surface="raised"
    >
      <header className="flex items-start justify-between gap-[var(--or-space-3)]">
        <div className="min-w-0">
          <p className="font-[family-name:var(--or-font-technical)] font-semibold tracking-[var(--or-type-eyebrow-tracking)] text-[var(--or-text-accent)] uppercase [font-size:var(--or-type-eyebrow-size)] [line-height:var(--or-type-eyebrow-line)]">
            Local transcript
          </p>
          <h2
            className="mt-[var(--or-space-1)] text-balance font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
            id="transcript-editor-heading"
            ref={headingRef}
            tabIndex={-1}
          >
            Edit {filename(workspace.assetPath)}
          </h2>
        </div>
        <Button disabled={workspace.isSaving} onClick={onClose} size="sm" variant="ghost">
          Close
        </Button>
      </header>

      {workspace.error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Reload transcript
            </Button>
          }
          className="mt-[var(--or-space-4)]"
          title="Transcript request failed"
          variant="error"
        >
          {workspace.error}
        </Alert>
      )}

      {workspace.notice !== undefined && (
        <Alert className="mt-[var(--or-space-4)]" title="Action complete" variant="success">
          {workspace.notice}
        </Alert>
      )}

      {workspace.isLoading ? (
        <div
          aria-live="polite"
          className="mt-[var(--or-space-5)] flex items-center gap-[var(--or-space-3)]"
          role="status"
        >
          <Spinner />
          <p className="[font-size:var(--or-type-interface-size)]">Loading transcript…</p>
        </div>
      ) : transcript === undefined ? (
        <ResourceEmptyState
          className="mt-[var(--or-space-5)]"
          description={
            <>
              No generated transcript is attached to this media item yet. Manage the local model
              catalog in{' '}
              <a className="text-[var(--or-text-link)] underline" href="/models">
                Models
              </a>
              .
            </>
          }
          title="No transcript available"
        />
      ) : (
        <form className="mt-[var(--or-space-5)]" onKeyDown={submitShortcut} onSubmit={submit}>
          <div className="flex flex-wrap items-center gap-[var(--or-space-2)] border-b border-[var(--or-border-subtle)] pb-[var(--or-space-4)]">
            <Badge variant="neutral">{transcript.language ?? 'Auto language'}</Badge>
            <Badge variant="neutral">{draft.length} cues</Badge>
            {transcript.hasUserEdits && <Badge variant="info">User edited</Badge>}
          </div>
          <dl className="grid gap-[var(--or-space-1)] py-[var(--or-space-4)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)]">
            <div className="flex min-w-0 justify-between gap-[var(--or-space-3)]">
              <dt>Engine</dt>
              <dd className="min-w-0 break-all text-right font-[family-name:var(--or-font-technical)] text-[var(--or-text-secondary)]">
                {transcript.providerId}/{transcript.model.id}
              </dd>
            </div>
            <div className="flex min-w-0 justify-between gap-[var(--or-space-3)]">
              <dt>Transcript ID</dt>
              <dd
                className="min-w-0 break-all text-right font-[family-name:var(--or-font-technical)] text-[var(--or-text-secondary)]"
                translate="no"
              >
                {transcript.id}
              </dd>
            </div>
          </dl>

          <div className="grid gap-[var(--or-space-4)]">
            {visibleDraft.map((cue, visibleIndex) => {
              const index = page * pageSize + visibleIndex;
              return (
                <fieldset
                  className="grid gap-[var(--or-space-3)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-4)]"
                  key={index}
                >
                  <legend className="pr-[var(--or-space-2)] font-[family-name:var(--or-font-technical)] font-semibold text-[var(--or-text-tertiary)] tabular-nums [font-size:var(--or-type-metadata-size)]">
                    Cue {index + 1}
                  </legend>
                  <div className="grid gap-[var(--or-space-3)] sm:grid-cols-2">
                    <FormField
                      {...(errors[`${index}.start`] === undefined
                        ? {}
                        : { error: errors[`${index}.start`] })}
                      label="Start"
                      required
                    >
                      <Input
                        autoComplete="off"
                        className="font-[family-name:var(--or-font-technical)] tabular-nums"
                        data-transcript-field={`${index}.start`}
                        disabled={workspace.isSaving}
                        inputMode="decimal"
                        name={`cue-${index}-start`}
                        onChange={(event) => updateCue(index, 'start', event.target.value)}
                        spellCheck={false}
                        value={cue.start}
                      />
                    </FormField>
                    <FormField
                      {...(errors[`${index}.end`] === undefined
                        ? {}
                        : { error: errors[`${index}.end`] })}
                      label="End"
                      required
                    >
                      <Input
                        autoComplete="off"
                        className="font-[family-name:var(--or-font-technical)] tabular-nums"
                        data-transcript-field={`${index}.end`}
                        disabled={workspace.isSaving}
                        inputMode="decimal"
                        name={`cue-${index}-end`}
                        onChange={(event) => updateCue(index, 'end', event.target.value)}
                        spellCheck={false}
                        value={cue.end}
                      />
                    </FormField>
                  </div>
                  <FormField
                    {...(errors[`${index}.text`] === undefined
                      ? {}
                      : { error: errors[`${index}.text`] })}
                    label="Caption text"
                    required
                  >
                    <Textarea
                      autoComplete="off"
                      data-transcript-field={`${index}.text`}
                      disabled={workspace.isSaving}
                      name={`cue-${index}-text`}
                      onChange={(event) => updateCue(index, 'text', event.target.value)}
                      value={cue.text}
                    />
                  </FormField>
                </fieldset>
              );
            })}
          </div>

          {pageCount > 1 && (
            <nav
              aria-label="Transcript cue pages"
              className="mt-[var(--or-space-4)] flex items-center justify-between gap-[var(--or-space-3)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-4)]"
            >
              <Button
                disabled={page === 0 || workspace.isSaving}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                size="sm"
                variant="ghost"
              >
                Previous
              </Button>
              <span className="text-center font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] tabular-nums [font-size:var(--or-type-metadata-size)]">
                {page + 1} / {pageCount}
              </span>
              <Button
                disabled={page >= pageCount - 1 || workspace.isSaving}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                size="sm"
                variant="ghost"
              >
                Next
              </Button>
            </nav>
          )}

          <p
            className="mt-[var(--or-space-4)] text-pretty text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]"
            id={exportHelpId}
          >
            Times use HH:MM:SS.mmm. Overlapping cues are allowed; start times must remain in order.
            Save edits before exporting the deterministic subtitle file.
          </p>
          <div className="mt-[var(--or-space-4)] flex flex-wrap gap-[var(--or-space-2)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-4)]">
            <Button
              disabled={!isDirty}
              isLoading={workspace.isSaving}
              loadingLabel="Saving…"
              type="submit"
              variant="primary"
            >
              Save transcript
            </Button>
            {(['srt', 'vtt'] as const).map((format) => (
              <Button
                aria-describedby={exportHelpId}
                disabled={exportDisabled || workspace.exportingFormat !== undefined}
                isLoading={workspace.exportingFormat === format}
                key={format}
                loadingLabel={`Exporting ${format.toUpperCase()}…`}
                onClick={() => onExport(format)}
                size="sm"
                variant="secondary"
              >
                Export {format.toUpperCase()}
              </Button>
            ))}
          </div>
        </form>
      )}
    </Panel>
  );
}
