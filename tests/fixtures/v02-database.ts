import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations, openDatabase, runMigrations } from '@openrepurpose/db';
import type { OpenRepurposeDatabase } from '@openrepurpose/db';

export interface V02DatabaseFixture {
  readonly database: OpenRepurposeDatabase;
  readonly directory: string;
  dispose(): void;
}

/** Builds a representative populated v0.2 database before upgrading it in migration tests. */
export function createV02DatabaseFixture(): V02DatabaseFixture {
  const directory = mkdtempSync(join(tmpdir(), 'openrepurpose-v02-migration-'));
  const database = openDatabase(join(directory, 'openrepurpose.sqlite'));
  runMigrations(database, migrations.slice(0, 8));

  const now = 1_758_000_000_000;
  database.client
    .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?), (?, ?, ?)`)
    .run('library.mode', 'referenced', now, 'watch.settle_ms', '10000', now);
  database.client
    .prepare(
      `INSERT INTO accounts (
        id, provider, external_id, display_name, status, capabilities_json,
        connected_at, updated_at
      ) VALUES (?, 'youtube', ?, ?, 'connected', ?, ?, ?),
               (?, 'tiktok', ?, ?, 'connected', ?, ?, ?)`,
    )
    .run(
      'youtube-v02',
      'youtube-channel-v02',
      'Creator Channel',
      '["youtube.identity.read","youtube.video.upload"]',
      now,
      now,
      'tiktok-v02',
      'tiktok-open-id-v02',
      'TikTok Creator',
      '["tiktok.identity.read","tiktok.video.publish"]',
      now,
      now,
    );
  database.client
    .prepare(
      `INSERT INTO workflows (
        id, name, enabled, source_directory, title_template, description_template,
        failure_policy, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, 'best_effort', ?, ?)`,
    )
    .run(
      'workflow-v02',
      'v0.2 watched uploads',
      'C:\\OpenRepurpose\\watched',
      '{{file.stem}}',
      'Imported from v0.2',
      now,
      now,
    );
  database.client
    .prepare(
      `INSERT INTO workflow_destinations
        (workflow_id, destination_id, account_id, position, configuration_json)
       VALUES (?, 'youtube', ?, 0, ?), (?, 'tiktok', ?, 1, ?)`,
    )
    .run(
      'workflow-v02',
      'youtube-v02',
      '{"privacy":"private","category":"22"}',
      'workflow-v02',
      'tiktok-v02',
      '{"privacyLevel":"SELF_ONLY","captionTemplate":"{{file.stem}}"}',
    );

  return {
    database,
    directory,
    dispose: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
