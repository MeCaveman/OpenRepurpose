import { afterEach, describe, expect, it } from 'vitest';
import {
  allRequiredSourceDestinationsSucceeded,
  isOpenRepurposeManagedMedia,
  sourceDestinationNeedsWork,
} from '@openrepurpose/core';
import { createTemporaryDatabase, type TemporaryDatabase } from '@openrepurpose/testkit';

function seedSource(temporary: TemporaryDatabase): void {
  const client = temporary.database.client;
  client
    .prepare(
      `INSERT INTO source_connections (
        id, adapter_id, external_source_id, display_name, configuration_json, status,
        consecutive_poll_failures, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '{}', 'active', 0, ?, ?)`,
    )
    .run('source-1', 'mock', 'channel-1', 'Channel', 1, 1);
  client
    .prepare(
      `INSERT INTO source_items (
        id, source_connection_id, external_id, dedupe_key, event_id, published_at,
        first_observed_at, last_observed_at, metadata_json, lifecycle_status,
        resolution_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', 'unresolved', ?)`,
    )
    .run(
      'item-1',
      'source-1',
      'external-item-1',
      'mock:channel-1:external-item-1',
      'event-1',
      10,
      11,
      11,
      '{"title":"Persistent title"}',
      11,
    );
}

function seedExecution(
  temporary: TemporaryDatabase,
  options: {
    readonly cleanupStatus?: 'not_eligible' | 'retained';
    readonly durationSeconds?: number;
    readonly id?: string;
    readonly policy?: 'delete_after_success' | 'keep_for_duration' | 'keep_forever';
    readonly version?: string;
  } = {},
): void {
  const policy = options.policy ?? 'delete_after_success';
  temporary.database.client
    .prepare(
      `INSERT INTO source_workflow_executions (
        id, source_item_id, workflow_key, workflow_version, status, snapshot_json,
        retention_policy, retention_duration_seconds, cleanup_status, created_at, updated_at
      ) VALUES (?, 'item-1', 'workflow-1', ?, 'pending', '{}', ?, ?, ?, 20, 20)`,
    )
    .run(
      options.id ?? 'execution-1',
      options.version ?? 'version-1',
      policy,
      options.durationSeconds ?? null,
      options.cleanupStatus ?? (policy === 'keep_forever' ? 'retained' : 'not_eligible'),
    );
}

function seedDestination(
  temporary: TemporaryDatabase,
  input: {
    readonly id: string;
    readonly key: string;
    readonly required: boolean;
    readonly status: 'failed' | 'pending' | 'succeeded';
  },
): void {
  temporary.database.client
    .prepare(
      `INSERT INTO source_execution_destinations (
        id, execution_id, destination_key, destination_id, required, idempotency_key,
        status, remote_id, attempt_count, created_at, updated_at, completed_at
      ) VALUES (?, 'execution-1', ?, ?, ?, ?, ?, ?, 1, 30, 30, ?)`,
    )
    .run(
      input.id,
      input.key,
      input.key.split(':')[0],
      input.required ? 1 : 0,
      `source:execution-1:${input.key}`,
      input.status,
      input.status === 'succeeded' ? `remote-${input.id}` : null,
      input.status === 'succeeded' ? 30 : null,
    );
}

describe('source-domain persistence and recovery invariants', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  it('deduplicates stable source identities and workflow versions independently of event IDs', () => {
    temporary = createTemporaryDatabase();
    seedSource(temporary);
    seedExecution(temporary);
    const client = temporary.database.client;

    expect(() =>
      client
        .prepare(
          `INSERT INTO source_items (
            id, source_connection_id, external_id, dedupe_key, event_id, first_observed_at,
            last_observed_at, metadata_json, lifecycle_status, resolution_status, updated_at
          ) VALUES ('item-duplicate', 'source-1', 'external-item-1', 'other-key', 'event-2',
            12, 12, '{}', 'observed', 'unresolved', 12)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      client
        .prepare(
          `INSERT INTO source_workflow_executions (
            id, source_item_id, workflow_key, workflow_version, status, snapshot_json,
            retention_policy, cleanup_status, created_at, updated_at
          ) VALUES ('execution-duplicate', 'item-1', 'workflow-1', 'version-1', 'pending',
            '{}', 'delete_after_success', 'not_eligible', 21, 21)`,
        )
        .run(),
    ).toThrow();

    expect(
      client
        .prepare('SELECT lifecycle_status, completed_at FROM source_items WHERE id = ?')
        .get('item-1'),
    ).toEqual({ completed_at: null, lifecycle_status: 'observed' });
  });

  it('keeps successful destinations terminal and permits cleanup only after required successes', () => {
    temporary = createTemporaryDatabase();
    seedSource(temporary);
    seedExecution(temporary);
    seedDestination(temporary, {
      id: 'destination-a',
      key: 'youtube:account-a',
      required: true,
      status: 'succeeded',
    });
    seedDestination(temporary, {
      id: 'destination-b',
      key: 'tiktok:account-b',
      required: true,
      status: 'failed',
    });
    seedDestination(temporary, {
      id: 'destination-optional',
      key: 'facebook:page-c',
      required: false,
      status: 'failed',
    });
    const client = temporary.database.client;

    expect(sourceDestinationNeedsWork({ required: true, status: 'succeeded' })).toBe(false);
    expect(sourceDestinationNeedsWork({ required: true, status: 'failed' })).toBe(true);
    expect(
      allRequiredSourceDestinationsSucceeded([
        { required: true, status: 'succeeded' },
        { required: true, status: 'failed' },
        { required: false, status: 'failed' },
      ]),
    ).toBe(false);
    expect(() =>
      client
        .prepare(
          "UPDATE source_execution_destinations SET status = 'retrying' WHERE id = 'destination-a'",
        )
        .run(),
    ).toThrow('successful destination checkpoint is terminal');
    expect(() =>
      client
        .prepare(
          `UPDATE source_workflow_executions
           SET cleanup_status = 'eligible', cleanup_eligible_at = 40
           WHERE id = 'execution-1'`,
        )
        .run(),
    ).toThrow('required destinations must succeed before cleanup');

    client
      .prepare(
        `UPDATE source_execution_destinations
         SET status = 'succeeded', remote_id = 'remote-b', completed_at = 41, updated_at = 41
         WHERE id = 'destination-b'`,
      )
      .run();
    expect(() =>
      client
        .prepare(
          `UPDATE source_workflow_executions
           SET cleanup_status = 'eligible', cleanup_eligible_at = 41
           WHERE id = 'execution-1'`,
        )
        .run(),
    ).not.toThrow();
  });

  it('enforces all retention variants and protects user-owned originals from cleanup state', () => {
    temporary = createTemporaryDatabase();
    seedSource(temporary);
    seedExecution(temporary);
    seedExecution(temporary, {
      durationSeconds: 86_400,
      id: 'execution-duration',
      policy: 'keep_for_duration',
      version: 'version-2',
    });
    seedExecution(temporary, {
      cleanupStatus: 'retained',
      id: 'execution-forever',
      policy: 'keep_forever',
      version: 'version-3',
    });
    const client = temporary.database.client;

    expect(() =>
      client
        .prepare(
          `INSERT INTO source_media_artifacts (
            id, source_item_id, execution_id, path, ownership, state, cleanup_state,
            created_at, updated_at
          ) VALUES ('original', 'item-1', 'execution-1', 'D:\\Media\\original.mp4',
            'user_owned_original', 'available', 'protected', 30, 30)`,
        )
        .run(),
    ).not.toThrow();
    expect(isOpenRepurposeManagedMedia('user_owned_original')).toBe(false);
    expect(isOpenRepurposeManagedMedia('openrepurpose_temporary')).toBe(true);
    expect(() =>
      client
        .prepare(
          `UPDATE source_media_artifacts
           SET state = 'deleted', cleanup_state = 'completed', deleted_at = 31
           WHERE id = 'original'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      client
        .prepare(
          `UPDATE source_media_artifacts
           SET ownership = 'openrepurpose_temporary', cleanup_state = 'not_eligible'
           WHERE id = 'original'`,
        )
        .run(),
    ).toThrow('source media artifact ownership is immutable');
    expect(() =>
      client
        .prepare(
          `UPDATE source_workflow_executions
           SET cleanup_status = 'eligible', cleanup_eligible_at = 50
           WHERE id = 'execution-forever'`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      seedExecution(temporary!, {
        id: 'execution-invalid-duration',
        policy: 'keep_for_duration',
        version: 'version-4',
      }),
    ).toThrow();
  });

  it('retains source, execution, destination, and artifact history after managed file deletion', () => {
    temporary = createTemporaryDatabase();
    seedSource(temporary);
    seedExecution(temporary);
    seedDestination(temporary, {
      id: 'destination-a',
      key: 'youtube:account-a',
      required: true,
      status: 'succeeded',
    });
    const client = temporary.database.client;
    client
      .prepare(
        `UPDATE source_workflow_executions
         SET cleanup_status = 'eligible', cleanup_eligible_at = 40
         WHERE id = 'execution-1'`,
      )
      .run();
    client
      .prepare(
        `INSERT INTO source_media_artifacts (
          id, source_item_id, execution_id, path, ownership, state, cleanup_state,
          created_at, updated_at
        ) VALUES ('temporary', 'item-1', 'execution-1', 'managed/temp/execution-1/source.mp4',
          'openrepurpose_temporary', 'available', 'eligible', 30, 40)`,
      )
      .run();
    client
      .prepare(
        `UPDATE source_media_artifacts
         SET state = 'deleted', cleanup_state = 'completed', deleted_at = 50, updated_at = 50
         WHERE id = 'temporary'`,
      )
      .run();

    expect(
      client.prepare('SELECT metadata_json FROM source_items WHERE id = ?').get('item-1'),
    ).toEqual({ metadata_json: '{"title":"Persistent title"}' });
    expect(
      client
        .prepare('SELECT status, remote_id FROM source_execution_destinations WHERE id = ?')
        .get('destination-a'),
    ).toEqual({ remote_id: 'remote-destination-a', status: 'succeeded' });
    expect(
      client
        .prepare('SELECT state, deleted_at FROM source_media_artifacts WHERE id = ?')
        .get('temporary'),
    ).toEqual({ deleted_at: 50, state: 'deleted' });
    expect(() =>
      client.prepare("DELETE FROM source_media_artifacts WHERE id = 'temporary'").run(),
    ).toThrow('source media artifact history must be retained');
  });
});
