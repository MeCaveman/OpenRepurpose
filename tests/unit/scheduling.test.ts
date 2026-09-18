import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { FakeClock, resolveOneTimeLocal, ScheduleService } from '@openrepurpose/core';
import { SqliteScheduleRepository, SqliteSourcePollingRepository } from '@openrepurpose/db';
import { createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';
import { createCli } from '../../apps/cli/src/index.js';
import type { Environment } from '@openrepurpose/shared';

describe('persistent schedules', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());

  it('materializes one coalesced recurring occurrence and never duplicates it after restart', async () => {
    temporary = createTemporaryDatabase();
    const clock = new FakeClock(new Date('2026-09-19T10:01:00.000Z'));
    const sources = new SqliteSourcePollingRepository(temporary.database);
    const source = sources.createConnection({
      adapterId: 'youtube',
      configuration: { accountId: 'a' },
      displayName: 'Source',
      externalSourceId: 'c',
      now: clock.now(),
    });
    const schedules = new SqliteScheduleRepository(temporary.database);
    const service = new ScheduleService(schedules, sources, clock);
    const schedule = service.create({
      definition: { kind: 'cron-v1', expression: '*/5 * * * *' },
      timeZone: 'America/New_York',
      target: { kind: 'source_poll', version: 1, sourceConnectionId: source.id },
    });
    expect(schedules.find(schedule.id)?.nextOccurrenceAt).toEqual(
      new Date('2026-09-19T10:05:00.000Z'),
    );

    clock.set(new Date('2026-09-19T10:21:00.000Z'));
    await service.runOnce();
    const first = temporary.database.client
      .prepare('SELECT scheduled_for_utc, dispatch_status FROM schedule_occurrences')
      .all() as { scheduled_for_utc: number; dispatch_status: string }[];
    expect(first).toEqual([
      { scheduled_for_utc: Date.parse('2026-09-19T10:05:00.000Z'), dispatch_status: 'dispatched' },
    ]);
    expect(schedules.find(schedule.id)?.nextOccurrenceAt).toEqual(
      new Date('2026-09-19T10:25:00.000Z'),
    );
    expect(sources.findConnection(source.id)).toMatchObject({
      cadenceOwner: 'schedule',
      nextPollAt: clock.now(),
    });

    await new ScheduleService(schedules, sources, clock).runOnce();
    expect(
      temporary.database.client.prepare('SELECT count(*) AS count FROM schedule_occurrences').get(),
    ).toEqual({ count: 1 });
  });

  it('persists a one-time resolved UTC instant and rejects a nonexistent local time', async () => {
    temporary = createTemporaryDatabase();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const sources = new SqliteSourcePollingRepository(temporary.database);
    const source = sources.createConnection({
      adapterId: 'youtube',
      configuration: { accountId: 'a' },
      displayName: 'Source',
      externalSourceId: 'c',
      now: clock.now(),
    });
    const schedules = new SqliteScheduleRepository(temporary.database);
    const service = new ScheduleService(schedules, sources, clock);
    expect(resolveOneTimeLocal('2026-11-01T01:30', 'America/New_York')).toEqual(
      new Date('2026-11-01T05:30:00.000Z'),
    );
    expect(() =>
      service.create({
        definition: { kind: 'once', requestedLocalTime: '2026-03-08T02:30' },
        timeZone: 'America/New_York',
        target: { kind: 'source_poll', version: 1, sourceConnectionId: source.id },
      }),
    ).toThrow('does not exist');

    const schedule = service.create({
      definition: { kind: 'once', requestedLocalTime: '2026-01-01T00:01' },
      timeZone: 'America/New_York',
      target: { kind: 'source_poll', version: 1, sourceConnectionId: source.id },
    });
    expect(schedules.find(schedule.id)?.definition).toMatchObject({
      kind: 'once',
      resolvedAt: new Date('2026-01-01T05:01:00.000Z'),
    });
    clock.set(new Date('2026-01-01T05:02:00.000Z'));
    await service.runOnce();
    expect(schedules.find(schedule.id)?.status).toBe('completed');
  });

  it('lists and shows schedules through the CLI', async () => {
    temporary = createTemporaryDatabase();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const sources = new SqliteSourcePollingRepository(temporary.database);
    const source = sources.createConnection({
      adapterId: 'youtube',
      configuration: { accountId: 'a' },
      displayName: 'Source',
      externalSourceId: 'c',
      now: clock.now(),
    });
    const schedule = new ScheduleService(
      new SqliteScheduleRepository(temporary.database),
      sources,
      clock,
    ).create({
      definition: { kind: 'once', requestedLocalTime: '2026-01-01T00:01' },
      timeZone: 'America/New_York',
      target: { kind: 'source_poll', version: 1, sourceConnectionId: source.id },
    });
    const environment: Environment = {
      APP_CONFIG_DIR: join(temporary.directory, 'config'),
      APP_DATA_DIR: temporary.directory,
      APP_TEMP_DIR: join(temporary.directory, 'temp'),
      DATABASE_URL: join(temporary.directory, 'openrepurpose.sqlite'),
    };
    const output: string[] = [];

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'schedule',
      'list',
      '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '[]')).toMatchObject([
      { id: schedule.id, timeZone: 'America/New_York' },
    ]);

    await createCli({ environment, write: (value) => output.push(value) }).parseAsync([
      'node',
      'openrepurpose',
      'schedule',
      'show',
      schedule.id,
      '--json',
    ]);
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ id: schedule.id, status: 'active' });
  });
});
