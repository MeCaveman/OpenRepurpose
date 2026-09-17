import { randomUUID } from 'node:crypto';

export type MediaAssetState = 'available' | 'missing';

export interface MediaProbeMetadata {
  readonly audioCodec?: string;
  readonly durationSeconds?: number;
  readonly frameRate?: number;
  readonly hasAudio: boolean;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly width?: number;
}

export interface MediaAsset {
  readonly createdAt: Date;
  readonly fingerprint: string;
  readonly id: string;
  readonly metadata: MediaProbeMetadata;
  readonly modifiedAt: Date;
  readonly path: string;
  readonly sizeBytes: number;
  readonly state: MediaAssetState;
}

export interface InspectedLocalFile {
  readonly fingerprint: string;
  readonly modifiedAt: Date;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface LocalFileInspector {
  inspect(path: string): Promise<InspectedLocalFile>;
}

export interface MediaProbe {
  probe(path: string): Promise<MediaProbeMetadata>;
}

export interface MediaRepository {
  create(asset: MediaAsset): MediaAsset;
  findByFingerprint(fingerprint: string): MediaAsset | undefined;
  list(): readonly MediaAsset[];
}

export interface ImportMediaResult {
  readonly asset: MediaAsset;
  readonly duplicate: boolean;
}

/** Application service shared by HTTP, CLI, and later workflow entry points. */
export class MediaImportService {
  public constructor(
    private readonly files: LocalFileInspector,
    private readonly probe: MediaProbe,
    private readonly repository: MediaRepository,
  ) {}

  public async import(path: string): Promise<ImportMediaResult> {
    const file = await this.files.inspect(path);
    const existing = this.repository.findByFingerprint(file.fingerprint);
    if (existing !== undefined) return { asset: existing, duplicate: true };

    const metadata = await this.probe.probe(file.path);
    const asset: MediaAsset = {
      createdAt: new Date(),
      fingerprint: file.fingerprint,
      id: randomUUID(),
      metadata,
      modifiedAt: file.modifiedAt,
      path: file.path,
      sizeBytes: file.sizeBytes,
      state: 'available',
    };
    return { asset: this.repository.create(asset), duplicate: false };
  }
}
