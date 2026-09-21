import type { Migration } from './types.js';

/** Durable location metadata for a sidecar generated beside a transform derivative. */
export const transformCaptionSidecarsMigration: Migration = {
  id: '0022_transform_caption_sidecars',
  sql: `
    ALTER TABLE transform_derivatives ADD COLUMN sidecar_caption_path TEXT;
    ALTER TABLE transform_derivatives ADD COLUMN sidecar_caption_size_bytes INTEGER;
  `,
};
