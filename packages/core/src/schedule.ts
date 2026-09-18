import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  public constructor(private value: Date) {}
  public now(): Date {
    return new Date(this.value);
  }
  public set(value: Date): void {
    this.value = new Date(value);
  }
  public advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type ScheduleDispatchStatus = 'pending_dispatch' | 'dispatched' | 'failed';
export type ScheduleTarget = {
  readonly kind: 'source_poll';
  readonly sourceConnectionId: string;
  readonly version: 1;
};
export type ScheduleDefinition =
  | { readonly kind: 'once'; readonly requestedLocalTime: string; readonly resolvedAt: Date }
  | { readonly expression: string; readonly kind: 'cron-v1' };

export interface Schedule {
  readonly createdAt: Date;
  readonly definition: ScheduleDefinition;
  readonly id: string;
  readonly lastOccurrenceAt?: Date;
  readonly nextOccurrenceAt?: Date;
  readonly revision: number;
  readonly status: ScheduleStatus;
  readonly target: ScheduleTarget;
  readonly timeZone: string;
  readonly updatedAt: Date;
}

export interface ScheduleOccurrence {
  readonly createdAt: Date;
  readonly dispatchStatus: ScheduleDispatchStatus;
  readonly errorMessage?: string;
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduleRevision: number;
  readonly scheduledFor: Date;
  readonly target: ScheduleTarget;
  readonly updatedAt: Date;
}

export interface ScheduleRepository {
  create(schedule: Schedule): Schedule;
  find(id: string): Schedule | undefined;
  listDue(now: Date, limit: number): readonly Schedule[];
  listPendingDispatch(limit: number): readonly ScheduleOccurrence[];
  materialize(input: {
    readonly nextOccurrenceAt?: Date;
    readonly now: Date;
    readonly occurrence: ScheduleOccurrence;
    readonly scheduleId: string;
    readonly status: ScheduleStatus;
  }): boolean;
  markDispatched(id: string, now: Date): void;
  markDispatchFailed(id: string, message: string, now: Date): void;
}

export interface SourcePollScheduleRequester {
  enableScheduleCadence(connectionId: string, now: Date): boolean;
  requestScheduledPoll(connectionId: string, now: Date): boolean;
}

function validTimeZone(timeZone: string): string {
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format();
  } catch {
    throw new Error('A valid IANA timezone is required.');
  }
  if (!timeZone.includes('/')) throw new Error('A valid IANA timezone is required.');
  return timeZone;
}

function localParts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

/** Resolves a display-only local timestamp without relying on host-local Date parsing. */
export function resolveOneTimeLocal(requestedLocalTime: string, timeZone: string): Date {
  validTimeZone(timeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(requestedLocalTime);
  if (match === null) throw new Error('Requested local time must be YYYY-MM-DDTHH:mm.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const nominal = Date.UTC(year, month - 1, day, hour, minute);
  if (
    new Date(nominal).getUTCFullYear() !== year ||
    new Date(nominal).getUTCMonth() !== month - 1 ||
    new Date(nominal).getUTCDate() !== day
  )
    throw new Error('Requested local time is invalid.');
  const matches: Date[] = [];
  for (let offsetHours = -14; offsetHours <= 14; offsetHours += 1) {
    const candidate = new Date(nominal - offsetHours * 3_600_000);
    const parts = localParts(candidate, timeZone);
    if (
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      Number(parts.hour) === hour &&
      Number(parts.minute) === minute &&
      Number(parts.second) === 0
    )
      matches.push(candidate);
  }
  if (matches.length === 0)
    throw new Error('Requested local time does not exist in this timezone.');
  return new Date(Math.min(...matches.map((candidate) => candidate.getTime())));
}

export function nextCronOccurrence(expression: string, timeZone: string, after: Date): Date {
  validTimeZone(timeZone);
  if (expression.trim().split(/\s+/u).length !== 5)
    throw new Error('cron-v1 requires exactly five fields.');
  let cron: Cron;
  try {
    cron = new Cron(expression, { timezone: timeZone, mode: '5-part', domAndDow: false });
  } catch {
    throw new Error('Invalid cron-v1 expression.');
  }
  const next = cron.nextRun(new Date(after.getTime() + 1));
  if (next === null || next.getTime() <= after.getTime())
    throw new Error('Cron recurrence has no next run.');
  return next;
}

export class ScheduleService {
  public constructor(
    private readonly repository: ScheduleRepository,
    private readonly sourcePolls: SourcePollScheduleRequester,
    private readonly clock: Clock = systemClock,
  ) {}

  public create(input: {
    readonly definition:
      | { readonly kind: 'once'; readonly requestedLocalTime: string }
      | { readonly expression: string; readonly kind: 'cron-v1' };
    readonly target: ScheduleTarget;
    readonly timeZone: string;
  }): Schedule {
    const now = this.clock.now();
    const timeZone = validTimeZone(input.timeZone);
    if (
      input.target.kind !== 'source_poll' ||
      input.target.version !== 1 ||
      !input.target.sourceConnectionId.trim()
    )
      throw new Error('A supported schedule target is required.');
    const definition: ScheduleDefinition =
      input.definition.kind === 'once'
        ? {
            kind: 'once',
            requestedLocalTime: input.definition.requestedLocalTime,
            resolvedAt: resolveOneTimeLocal(input.definition.requestedLocalTime, timeZone),
          }
        : { kind: 'cron-v1', expression: input.definition.expression.trim() };
    const nextOccurrenceAt =
      definition.kind === 'once'
        ? definition.resolvedAt
        : nextCronOccurrence(definition.expression, timeZone, now);
    if (!this.sourcePolls.enableScheduleCadence(input.target.sourceConnectionId, now))
      throw new Error('The source connection cannot use a scheduled cadence.');
    return this.repository.create({
      id: randomUUID(),
      target: input.target,
      timeZone,
      definition,
      revision: 1,
      status: 'active',
      nextOccurrenceAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async runOnce(limit = 100): Promise<void> {
    const now = this.clock.now();
    for (const schedule of this.repository.listDue(now, limit)) {
      const occurrence: ScheduleOccurrence = {
        id: randomUUID(),
        scheduleId: schedule.id,
        scheduleRevision: schedule.revision,
        scheduledFor: schedule.nextOccurrenceAt!,
        target: structuredClone(schedule.target),
        dispatchStatus: 'pending_dispatch',
        createdAt: now,
        updatedAt: now,
      };
      const nextOccurrenceAt =
        schedule.definition.kind === 'cron-v1'
          ? nextCronOccurrence(schedule.definition.expression, schedule.timeZone, now)
          : undefined;
      this.repository.materialize({
        scheduleId: schedule.id,
        occurrence,
        now,
        ...(nextOccurrenceAt === undefined ? {} : { nextOccurrenceAt }),
        status: schedule.definition.kind === 'once' ? 'completed' : 'active',
      });
    }
    for (const occurrence of this.repository.listPendingDispatch(limit))
      this.dispatch(occurrence, now);
  }

  private dispatch(occurrence: ScheduleOccurrence, now: Date): void {
    try {
      if (occurrence.target.kind === 'source_poll') {
        this.sourcePolls.requestScheduledPoll(occurrence.target.sourceConnectionId, now);
        this.repository.markDispatched(occurrence.id, now);
      }
    } catch {
      this.repository.markDispatchFailed(occurrence.id, 'Scheduled dispatch failed.', now);
    }
  }
}

/** Timer is only a wake-up aid; runOnce reads durable state and is safe after restart. */
export class SchedulerLoop {
  private timer: NodeJS.Timeout | undefined;
  public constructor(
    private readonly schedules: ScheduleService,
    private readonly intervalMs = 1_000,
  ) {
    if (intervalMs < 25) throw new Error('Scheduler polling interval must be at least 25ms.');
  }
  public start(): void {
    if (this.timer !== undefined) return;
    void this.schedules.runOnce();
    this.timer = setInterval(() => void this.schedules.runOnce(), this.intervalMs);
  }
  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
