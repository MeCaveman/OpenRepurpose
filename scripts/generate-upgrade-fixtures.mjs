import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { migrations, openDatabase, runMigrations } from '../packages/db/dist/index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = join(repositoryRoot, 'tests', 'fixtures', 'upgrade');
const generationBackupDirectory = join(fixtureDirectory, '.generation-backups');
const generatedAt = '2026-09-24T00:00:00.000Z';
const v09SourceCommit = 'fa974d48b86881159506094b33058c55433aee3c';
const baseTime = Date.parse('2026-09-01T00:00:00.000Z');

const specs = [
  {
    file: 'v0.4-migrated-chain.sqlite.fixture',
    history: 'v0.1 database migrated in place through the v0.4 schema boundary',
    id: 'v0.4-migrated-chain',
    migrationCount: 14,
    seed: seedMigratedChain,
    sourceCommit: '7b56b33e7c72526d08332e1787f9f9b1d72c9e19',
  },
  {
    file: 'v0.8-latest.sqlite.fixture',
    history: 'latest v0.8 schema populated after its complete migration chain',
    id: 'v0.8-latest',
    migrationCount: 24,
    seed: seedModern,
    sourceCommit: '0e9d59a852a054bc6c2e1cdb2644c699838722fe',
  },
  {
    file: 'v0.9-latest.sqlite.fixture',
    history: 'latest v0.9 repository release boundary immediately before v1.0 Packet 1',
    id: 'v0.9-latest',
    migrationCount: 26,
    seed: seedModern,
    sourceCommit: v09SourceCommit,
  },
];

function sqlJson(value) {
  return JSON.stringify(value);
}

function seedV01(database) {
  database.client
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('fixture.release', 'v0.4-migrated-chain', baseTime);
  database.client
    .prepare(
      `INSERT INTO media_assets (
        id, path, fingerprint, size_bytes, modified_at, state, has_audio, created_at
      ) VALUES (?, ?, ?, ?, ?, 'available', 1, ?)`,
    )
    .run(
      'media-chain',
      'C:\\OpenRepurpose\\media\\chain.mp4',
      'sha256:chain-media',
      4096,
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO accounts (
        id, provider, external_id, display_name, status, capabilities_json, connected_at, updated_at
      ) VALUES (?, 'youtube', ?, ?, 'connected', ?, ?, ?)`,
    )
    .run(
      'account-chain',
      'channel-chain',
      'Migrated creator',
      sqlJson(['youtube.video.upload']),
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO jobs (
        id, type, status, input_json, idempotency_key, max_attempts, attempt_count,
        available_at, created_at, updated_at, completed_at
      ) VALUES (?, 'youtube.upload', 'succeeded', ?, ?, 3, 1, ?, ?, ?, ?)`,
    )
    .run(
      'job-chain',
      sqlJson({ accountId: 'account-chain', immutable: 'job-input-chain', mediaId: 'media-chain' }),
      'job-chain-idempotency',
      baseTime,
      baseTime,
      baseTime + 1_000,
      baseTime + 1_000,
    );
  database.client
    .prepare(
      `INSERT INTO job_attempts (
        id, job_id, attempt_number, status, lease_owner, started_at, finished_at, retryable
      ) VALUES (?, ?, 1, 'succeeded', 'fixture-worker', ?, ?, 0)`,
    )
    .run('attempt-chain', 'job-chain', baseTime, baseTime + 1_000);
  database.client
    .prepare(
      `INSERT INTO destination_job_records (
        job_id, destination_id, remote_id, remote_url, remote_status, uploaded_bytes, updated_at
      ) VALUES (?, 'youtube', ?, ?, 'published', 4096, ?)`,
    )
    .run(
      'job-chain',
      'remote-chain',
      'https://www.youtube.com/watch?v=fixture-chain',
      baseTime + 1_000,
    );
  database.client
    .prepare(
      `INSERT INTO workflows (
        id, name, enabled, source_directory, account_id, title_template, description_template,
        privacy, category, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, 'unlisted', '22', ?, ?)`,
    )
    .run(
      'workflow-chain',
      'Migrated chain workflow',
      'C:\\OpenRepurpose\\watch',
      'account-chain',
      '{{file.stem}}',
      'Migrated through every historical schema',
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO source_cursors (
        workflow_id, source_key, path, size_bytes, modified_at, observed_at, state, media_id
      ) VALUES (?, ?, ?, 4096, ?, ?, 'processed', ?)`,
    )
    .run(
      'workflow-chain',
      'source-chain',
      'C:\\OpenRepurpose\\watch\\chain.mp4',
      baseTime,
      baseTime + 500,
      'media-chain',
    );
}

function seedRemoteExecutionAtV04(database) {
  database.client
    .prepare(
      `INSERT INTO source_connections (
        id, adapter_id, account_id, external_source_id, display_name, configuration_json,
        status, cursor_json, watermark_published_at, watermark_external_id,
        last_poll_at, last_successful_poll_at, consecutive_poll_failures, next_poll_at,
        created_at, updated_at
      ) VALUES (?, 'youtube', ?, ?, ?, '{}', 'active', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      'source-chain',
      'account-chain',
      'channel-chain',
      'Migrated source',
      sqlJson({ pageToken: 'chain-cursor' }),
      baseTime,
      'source-item-chain',
      baseTime + 1_000,
      baseTime + 1_000,
      baseTime + 60_000,
      baseTime,
      baseTime + 1_000,
    );
  database.client
    .prepare(
      `INSERT INTO source_items (
        id, source_connection_id, external_id, dedupe_key, published_at,
        first_observed_at, last_observed_at, metadata_json, media_descriptor_json,
        lifecycle_status, resolution_status, linked_media_id, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'ready', ?, ?, ?)`,
    )
    .run(
      'source-item-chain',
      'source-chain',
      'source-item-chain',
      'dedupe-chain',
      baseTime,
      baseTime,
      baseTime,
      sqlJson({ title: 'Migrated source item' }),
      sqlJson({ kind: 'local_original', path: 'C:\\OpenRepurpose\\media\\chain.mp4' }),
      'media-chain',
      baseTime + 1_000,
      baseTime + 1_000,
    );
  database.client
    .prepare(
      `INSERT INTO source_workflow_executions (
        id, source_item_id, workflow_id, workflow_key, workflow_version, status, snapshot_json,
        retention_policy, retention_duration_seconds, cleanup_status, cleanup_eligible_at,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, 'keep_forever', NULL, 'retained', NULL, ?, ?, ?)`,
    )
    .run(
      'execution-chain',
      'source-item-chain',
      'workflow-chain',
      'workflow-chain',
      'v0.4-snapshot',
      sqlJson({ immutable: 'execution-snapshot-chain', titleTemplate: '{{source.title}}' }),
      baseTime,
      baseTime + 1_000,
      baseTime + 1_000,
    );
  database.client
    .prepare(
      `INSERT INTO source_execution_destinations (
        id, execution_id, destination_key, destination_id, required, job_id, idempotency_key,
        status, remote_id, remote_url, attempt_count, created_at, updated_at, completed_at
      ) VALUES (?, ?, 'youtube-primary', 'youtube', 1, ?, ?, 'succeeded', ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      'execution-destination-chain',
      'execution-chain',
      'job-chain',
      'execution-chain-youtube',
      'remote-chain',
      'https://www.youtube.com/watch?v=fixture-chain',
      baseTime,
      baseTime + 1_000,
      baseTime + 1_000,
    );
}

function seedMigratedChain(database, migrationCount) {
  runMigrations(database, migrations.slice(0, 6));
  seedV01(database);
  runMigrations(database, migrations.slice(0, migrationCount), {
    backupDirectory: generationBackupDirectory,
  });
  seedRemoteExecutionAtV04(database);
}

function seedModern(database, migrationCount, fixtureId) {
  runMigrations(database, migrations.slice(0, migrationCount));
  database.client
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('fixture.release', fixtureId, baseTime);
  database.client
    .prepare(
      `INSERT INTO media_assets (
        id, path, fingerprint, size_bytes, modified_at, state, duration_millis, video_codec,
        audio_codec, width, height, frame_rate_milli, has_audio, created_at
      ) VALUES (?, ?, ?, 8192, ?, 'available', 60000, 'h264', 'aac', 1920, 1080, 30000, 1, ?)`,
    )
    .run(
      `media-${fixtureId}`,
      `C:\\OpenRepurpose\\media\\${fixtureId}.mp4`,
      `sha256:${fixtureId}-media`,
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO accounts (
        id, provider, external_id, display_name, status, capabilities_json, connected_at, updated_at
      ) VALUES (?, 'youtube', ?, ?, 'connected', ?, ?, ?)`,
    )
    .run(
      `account-${fixtureId}`,
      `channel-${fixtureId}`,
      `${fixtureId} creator`,
      sqlJson(['youtube.video.upload', 'youtube.channel.read']),
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO meta_credentials (
        id, external_id, display_name, status, scopes_json, token_expires_at, connected_at, updated_at
      ) VALUES (?, ?, ?, 'connected', ?, ?, ?, ?)`,
    )
    .run(
      `meta-credential-${fixtureId}`,
      `meta-user-${fixtureId}`,
      `${fixtureId} Meta creator`,
      sqlJson(['pages_manage_posts']),
      baseTime + 86_400_000,
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO meta_publish_targets (
        id, credential_id, kind, external_id, page_id, display_name, enabled,
        availability, updated_at
      ) VALUES (?, ?, 'facebook_page', ?, ?, ?, 1, 'available', ?)`,
    )
    .run(
      `meta-target-${fixtureId}`,
      `meta-credential-${fixtureId}`,
      `page-${fixtureId}`,
      `page-${fixtureId}`,
      `${fixtureId} page`,
      baseTime,
    );

  const localDefinition = {
    edges: [{ from: 'source', to: 'destination-1' }],
    schemaVersion: 1,
    steps: [
      { id: 'source', kind: 'source', sourceType: 'watched_folder' },
      {
        destination: {
          accountId: `account-${fixtureId}`,
          category: null,
          destinationId: 'youtube',
          privacy: 'unlisted',
        },
        id: 'destination-1',
        kind: 'destination',
      },
    ],
  };
  const localPlan = {
    definitionVersion: 1,
    descriptionTemplate: 'Fixture description',
    destinations: [
      {
        accountId: `account-${fixtureId}`,
        category: null,
        destinationId: 'youtube',
        privacy: 'unlisted',
      },
    ],
    failurePolicy: 'best_effort',
    id: `workflow-${fixtureId}`,
    name: `${fixtureId} workflow`,
    planVersion: 'workflow-plan-v1',
    steps: localDefinition.steps,
    titleTemplate: '{{file.stem}}',
  };
  database.client
    .prepare(
      `INSERT INTO workflows (
        id, name, enabled, source_directory, title_template, description_template,
        failure_policy, definition_json, execution_plan_json, execution_plan_version,
        created_at, updated_at
      ) VALUES (?, ?, 1, ?, '{{file.stem}}', 'Fixture description', 'best_effort', ?, ?,
        'workflow-plan-v1', ?, ?)`,
    )
    .run(
      `workflow-${fixtureId}`,
      `${fixtureId} workflow`,
      `C:\\OpenRepurpose\\watch\\${fixtureId}`,
      sqlJson(localDefinition),
      sqlJson(localPlan),
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO workflow_destinations (
        workflow_id, destination_id, account_id, position, configuration_json
      ) VALUES (?, 'youtube', ?, 0, ?)`,
    )
    .run(
      `workflow-${fixtureId}`,
      `account-${fixtureId}`,
      sqlJson({ category: null, privacy: 'unlisted' }),
    );
  database.client
    .prepare(
      `INSERT INTO source_cursors (
        workflow_id, source_key, path, size_bytes, modified_at, observed_at, state, media_id
      ) VALUES (?, ?, ?, 8192, ?, ?, 'processed', ?)`,
    )
    .run(
      `workflow-${fixtureId}`,
      `cursor-${fixtureId}`,
      `C:\\OpenRepurpose\\watch\\${fixtureId}\\video.mp4`,
      baseTime,
      baseTime + 500,
      `media-${fixtureId}`,
    );
  database.client
    .prepare(
      `INSERT INTO source_connections (
        id, adapter_id, account_id, external_source_id, display_name, configuration_json,
        cadence_owner, scheduled_poll_pending, status, cursor_json,
        watermark_published_at, watermark_external_id, last_poll_at, last_successful_poll_at,
        consecutive_poll_failures, next_poll_at, created_at, updated_at
      ) VALUES (?, 'youtube', ?, ?, ?, '{}', 'schedule', 0, 'active', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      `source-${fixtureId}`,
      `account-${fixtureId}`,
      `channel-${fixtureId}`,
      `${fixtureId} source`,
      sqlJson({ pageToken: `${fixtureId}-cursor` }),
      baseTime,
      `item-${fixtureId}`,
      baseTime + 1_000,
      baseTime + 1_000,
      baseTime + 60_000,
      baseTime,
      baseTime + 1_000,
    );
  database.client
    .prepare(
      `INSERT INTO workflow_remote_sources (
        workflow_id, source_connection_id, filters_json, retention_policy,
        retention_duration_seconds, rights_confirmed, local_original_json
      ) VALUES (?, ?, '{}', 'keep_forever', NULL, 1, ?)`,
    )
    .run(
      `workflow-${fixtureId}`,
      `source-${fixtureId}`,
      sqlJson({ path: `C:\\OpenRepurpose\\media\\${fixtureId}.mp4` }),
    );
  database.client
    .prepare(
      `INSERT INTO source_items (
        id, source_connection_id, external_id, dedupe_key, published_at,
        first_observed_at, last_observed_at, metadata_json, media_descriptor_json,
        lifecycle_status, resolution_status, linked_media_id, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'ready', ?, ?, ?)`,
    )
    .run(
      `item-${fixtureId}`,
      `source-${fixtureId}`,
      `item-${fixtureId}`,
      `dedupe-${fixtureId}`,
      baseTime,
      baseTime,
      baseTime,
      sqlJson({ description: 'Fixture item', title: `${fixtureId} source item` }),
      sqlJson({ kind: 'local_original', path: `C:\\OpenRepurpose\\media\\${fixtureId}.mp4` }),
      `media-${fixtureId}`,
      baseTime + 2_000,
      baseTime + 2_000,
    );
  database.client
    .prepare(
      `INSERT INTO jobs (
        id, type, status, input_json, idempotency_key, max_attempts, attempt_count,
        available_at, platform_id, account_id, created_at, updated_at, completed_at
      ) VALUES (?, 'youtube.upload', 'succeeded', ?, ?, 3, 1, ?, 'youtube', ?, ?, ?, ?)`,
    )
    .run(
      `job-${fixtureId}`,
      sqlJson({
        accountId: `account-${fixtureId}`,
        immutable: `job-input-${fixtureId}`,
        mediaId: `media-${fixtureId}`,
      }),
      `job-${fixtureId}-idempotency`,
      baseTime,
      `account-${fixtureId}`,
      baseTime,
      baseTime + 2_000,
      baseTime + 2_000,
    );
  database.client
    .prepare(
      `INSERT INTO job_attempts (
        id, job_id, attempt_number, status, lease_owner, started_at, finished_at, retryable
      ) VALUES (?, ?, 1, 'succeeded', 'fixture-worker', ?, ?, 0)`,
    )
    .run(`attempt-${fixtureId}`, `job-${fixtureId}`, baseTime, baseTime + 2_000);
  database.client
    .prepare(
      `INSERT INTO destination_job_records (
        job_id, destination_id, remote_id, remote_url, remote_status, uploaded_bytes, updated_at
      ) VALUES (?, 'youtube', ?, ?, 'published', 8192, ?)`,
    )
    .run(
      `job-${fixtureId}`,
      `remote-${fixtureId}`,
      `https://www.youtube.com/watch?v=${fixtureId}`,
      baseTime + 2_000,
    );
  database.client
    .prepare(
      `INSERT INTO source_workflow_executions (
        id, source_item_id, workflow_id, workflow_key, workflow_version, status, snapshot_json,
        retention_policy, retention_duration_seconds, cleanup_status, cleanup_eligible_at,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, 'keep_forever', NULL, 'retained', NULL, ?, ?, ?)`,
    )
    .run(
      `execution-${fixtureId}`,
      `item-${fixtureId}`,
      `workflow-${fixtureId}`,
      `workflow-${fixtureId}`,
      `${fixtureId}-snapshot-v1`,
      sqlJson({ immutable: `execution-snapshot-${fixtureId}`, plan: localPlan }),
      baseTime,
      baseTime + 2_000,
      baseTime + 2_000,
    );
  database.client
    .prepare(
      `INSERT INTO source_execution_destinations (
        id, execution_id, destination_key, destination_id, required, job_id, idempotency_key,
        status, remote_id, remote_url, attempt_count, created_at, updated_at, completed_at
      ) VALUES (?, ?, 'youtube-primary', 'youtube', 1, ?, ?, 'succeeded', ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      `execution-destination-${fixtureId}`,
      `execution-${fixtureId}`,
      `job-${fixtureId}`,
      `execution-${fixtureId}-youtube`,
      `remote-${fixtureId}`,
      `https://www.youtube.com/watch?v=${fixtureId}`,
      baseTime,
      baseTime + 2_000,
      baseTime + 2_000,
    );
  database.client
    .prepare(
      `INSERT INTO schedules (
        id, status, revision, target_json, definition_json, time_zone,
        next_occurrence_at, last_occurrence_at, created_at, updated_at
      ) VALUES (?, 'active', 3, ?, ?, 'Asia/Riyadh', ?, ?, ?, ?)`,
    )
    .run(
      `schedule-${fixtureId}`,
      sqlJson({ kind: 'source_poll', sourceConnectionId: `source-${fixtureId}` }),
      sqlJson({ hour: 9, kind: 'daily', minute: 30 }),
      baseTime + 86_400_000,
      baseTime,
      baseTime,
      baseTime,
    );
  database.client
    .prepare(
      `INSERT INTO schedule_occurrences (
        id, schedule_id, schedule_revision, scheduled_for_utc, target_json,
        dispatch_status, created_at, updated_at
      ) VALUES (?, ?, 3, ?, ?, 'dispatched', ?, ?)`,
    )
    .run(
      `occurrence-${fixtureId}`,
      `schedule-${fixtureId}`,
      baseTime,
      sqlJson({ kind: 'source_poll', sourceConnectionId: `source-${fixtureId}` }),
      baseTime,
      baseTime,
    );

  if (migrationCount >= 26) {
    database.client
      .prepare(
        `INSERT INTO api_tokens (
          id, name, verifier, permissions_json, created_at, last_used_at, revoked_at
        ) VALUES (?, 'Fixture token', 'fixture-verifier-not-a-real-secret', '["read"]', ?, NULL, NULL)`,
      )
      .run(`token-${fixtureId}`, baseTime);
    database.client
      .prepare(
        `INSERT INTO webhook_destinations (
          id, name, url, events_json, enabled, created_at, updated_at
        ) VALUES (?, 'Fixture webhook', 'https://hooks.example.test/openrepurpose',
          '["job.succeeded"]', 1, ?, ?)`,
      )
      .run(`webhook-${fixtureId}`, baseTime, baseTime);
  }
}

function finalizeDatabase(database, migrationCount) {
  database.client.prepare('UPDATE __openrepurpose_migrations SET applied_at = ?').run(baseTime);
  const ledgerCount = database.client
    .prepare('SELECT COUNT(*) AS count FROM __openrepurpose_migrations')
    .get().count;
  if (ledgerCount !== migrationCount)
    throw new Error(`Expected ${migrationCount} migrations, found ${ledgerCount}.`);
  database.client.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;');
}

function createFixture(spec) {
  const path = join(fixtureDirectory, spec.file);
  rmSync(path, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-wal`, { force: true });
  const database = openDatabase(path);
  try {
    spec.seed(database, spec.migrationCount, spec.id);
    finalizeDatabase(database, spec.migrationCount);
  } finally {
    database.close();
  }
  const bytes = readFileSync(path);
  return {
    file: relative(repositoryRoot, path).replaceAll('\\', '/'),
    history: spec.history,
    id: spec.id,
    migrationIds: migrations.slice(0, spec.migrationCount).map((migration) => migration.id),
    schemaVersion: migrations[spec.migrationCount - 1].id,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    sourceCommit: spec.sourceCommit,
  };
}

if (migrations.at(-1)?.id !== '0027_v1_compatibility')
  throw new Error('Review the fixture matrix before regenerating it for a new schema boundary.');

mkdirSync(fixtureDirectory, { recursive: true });
rmSync(generationBackupDirectory, { force: true, recursive: true });
const fixtures = specs.map(createFixture);
rmSync(generationBackupDirectory, { force: true, recursive: true });
writeFileSync(
  join(fixtureDirectory, 'manifest.json'),
  `${JSON.stringify(
    {
      fixtures,
      generatedAt,
      provenance: {
        note: 'v0.9 had no release tag; the fixture is pinned to the final v0.9 commit before v1.0 work.',
        v09SourceCommit,
      },
    },
    null,
    2,
  )}\n`,
);

for (const fixture of fixtures)
  process.stdout.write(`${fixture.id}\t${fixture.sha256}\t${fixture.sizeBytes}\n`);
