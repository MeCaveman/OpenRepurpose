import { afterEach, describe, expect, it } from 'vitest';
import { SourceService } from '@openrepurpose/core';
import { SqliteSourcePollingRepository } from '@openrepurpose/db';
import { createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

describe('source management service', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('adds, pauses, resumes, and schedules a YouTube source without creating a second job system', () => {
    temporary = createTemporaryDatabase();
    let now = 1_000;
    const service = new SourceService(
      new SqliteSourcePollingRepository(temporary.database),
      () => new Date(now),
    );

    const source = service.addYouTube({ accountId: 'account-1', channelId: 'channel-1' });
    expect(source).toMatchObject({
      adapterId: 'youtube',
      configuration: { accountId: 'account-1' },
      externalSourceId: 'channel-1',
      status: 'active',
    });
    expect(service.pause(source.id)?.status).toBe('paused');
    expect(service.poll(source.id)?.nextPollAt).toBeUndefined();
    now = 2_000;
    expect(service.resume(source.id)).toMatchObject({
      status: 'active',
      nextPollAt: new Date(now),
    });
    expect(service.poll(source.id)?.nextPollAt).toEqual(new Date(now));
    expect(service.items(source.id)).toEqual([]);
  });
});
