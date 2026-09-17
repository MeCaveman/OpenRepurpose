export type DestinationMediaKind = 'audio' | 'image' | 'video';

export type DestinationPrivacy = 'private' | 'public' | 'unlisted';

export interface TextFieldCapability {
  readonly maxLength?: number;
  readonly required: boolean;
  readonly supported: boolean;
}

export interface ListFieldCapability {
  readonly maxItemLength?: number;
  readonly maxItems?: number;
  readonly supported: boolean;
}

export interface DestinationCapabilities {
  readonly media: {
    readonly kinds: readonly DestinationMediaKind[];
    readonly maxDurationSeconds?: number;
    readonly maxFileSizeBytes?: number;
  };
  readonly metadata: {
    readonly category: TextFieldCapability;
    readonly description: TextFieldCapability;
    readonly tags: ListFieldCapability;
    readonly title: TextFieldCapability;
  };
  readonly privacy: {
    readonly supported: boolean;
    readonly values: readonly DestinationPrivacy[];
  };
  readonly resumableUpload: boolean;
  readonly statusPolling: boolean;
}

export interface PublishMedia {
  readonly durationSeconds?: number;
  readonly id: string;
  readonly kind: DestinationMediaKind;
  readonly mimeType?: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface PublishMetadata {
  readonly category?: string;
  readonly description?: string;
  readonly privacy?: DestinationPrivacy;
  readonly tags?: readonly string[];
  readonly title?: string;
}

/** Deliberately contains no credentials; adapters resolve them through AdapterContext.secretStore. */
export interface PublishRequest {
  readonly accountId: string;
  readonly media: PublishMedia;
  readonly metadata: PublishMetadata;
}

export interface ValidationIssue {
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export type ValidationResult =
  { readonly valid: true } | { readonly issues: readonly ValidationIssue[]; readonly valid: false };

export type RemotePublishState = 'failed' | 'processing' | 'published';

export interface PublishResult {
  readonly remoteId: string;
  readonly state: RemotePublishState;
  readonly url?: string;
}

export interface RemoteStatus {
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly state: RemotePublishState;
  readonly url?: string;
}
