import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type {
  AccountCapability,
  AccountRepository,
  ConnectedAccount,
  DestinationJobRecord,
  DestinationJobRepository,
  JobHandler,
  JobHandlerContext,
  JsonValue,
  MediaRepository,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
} from '@openrepurpose/core';
import { JobExecutionError } from '@openrepurpose/core';
import type {
  DestinationCapabilities,
  PublishMetadata,
  SecretReference,
  SecretStore,
  SourceAdapter,
  SourceAdapterContext,
  SourceCapabilities,
  SourceItemObservation,
  SourceJsonValue,
  SourcePollRequest,
  SourcePollResult,
} from '@openrepurpose/platform-sdk';
import { PlatformError } from '@openrepurpose/platform-sdk';

export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_FULL_SCOPE = 'https://www.googleapis.com/auth/youtube';
const YOUTUBE_FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const clientIdReference: SecretReference = {
  name: 'client-id',
  ownerId: 'youtube',
  scope: 'application',
};
const clientSecretReference: SecretReference = {
  name: 'client-secret',
  ownerId: 'youtube',
  scope: 'application',
};

export function youtubeRefreshTokenReference(accountId: string): SecretReference {
  return { name: 'youtube-refresh-token', ownerId: accountId, scope: 'account' };
}

function verifierReference(requestId: string): SecretReference {
  return {
    name: 'code-verifier',
    ownerId: `youtube-oauth:${requestId}`,
    scope: 'application',
  };
}

export interface YouTubeOAuthEndpoints {
  readonly authorization: string;
  readonly channels: string;
  readonly token: string;
}

export interface OAuthHttpClient {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface ConfigureYouTubeCredentialsInput {
  readonly clientId: string;
  readonly clientSecret?: string;
}

export interface YouTubeCredentialStatus {
  readonly clientSecretConfigured: boolean;
  readonly configured: boolean;
  readonly redirectUri: string;
}

export interface YouTubeOAuthStart {
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
}

export interface YouTubeOAuthCallbackInput {
  readonly browserBinding?: string;
  readonly code?: string;
  readonly error?: string;
  readonly state?: string;
}

export interface YouTubeOAuthServiceOptions {
  readonly endpoints?: Partial<YouTubeOAuthEndpoints>;
  readonly flowLifetimeMs?: number;
  readonly http?: OAuthHttpClient;
  readonly now?: () => Date;
}

interface TokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken?: string;
  readonly scopes?: readonly string[];
}

interface YouTubeCredentials {
  readonly clientId: string;
  readonly clientSecret?: string;
}

const defaultEndpoints: YouTubeOAuthEndpoints = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  channels: 'https://www.googleapis.com/youtube/v3/channels',
  token: 'https://oauth2.googleapis.com/token',
};

const defaultUploadEndpoints = {
  upload: 'https://www.googleapis.com/upload/youtube/v3/videos',
  videos: 'https://www.googleapis.com/youtube/v3/videos',
};

export const YOUTUBE_UPLOAD_JOB_TYPE = 'youtube.upload';

const youtubeDataApiBaseUrl = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeSourceConfiguration {
  readonly accountId: string;
  readonly filters?: {
    readonly includeShorts?: boolean;
    readonly privacyStatuses?: readonly ('private' | 'public' | 'unlisted')[];
    readonly publishedAfter?: string;
    readonly shortsMaxDurationSeconds?: number;
    readonly titleRegex?: string;
    readonly titleSubstring?: string;
  };
}

export interface YouTubeAccessTokenProvider {
  refreshAccessToken(accountId: string): Promise<string>;
}

export interface YouTubeSourceAdapterOptions {
  readonly apiBaseUrl?: string;
  readonly http?: OAuthHttpClient;
}

interface YouTubeWatermark {
  readonly externalId: string;
  readonly publishedAt: string;
}

interface YouTubeSourceCursor {
  readonly nextPageToken?: string;
  readonly version: 1;
  readonly watermark?: YouTubeWatermark;
}

interface YouTubeUploadCandidate {
  readonly description: string;
  readonly externalId: string;
  readonly privacyStatus?: string;
  readonly publishedAt: string;
  readonly title: string;
}

/**
 * Detection-only YouTube source adapter. It uses each channel's uploads playlist rather than
 * `search.list`; no media bytes are requested or resolved here.
 */
export class YouTubeSourceAdapter implements SourceAdapter {
  public readonly displayName = 'YouTube';
  public readonly id = 'youtube';

  private readonly apiBaseUrl: string;
  private readonly http: OAuthHttpClient;
  private readonly uploadsPlaylists = new Map<string, string>();

  public constructor(
    private readonly tokens: YouTubeAccessTokenProvider,
    options: YouTubeSourceAdapterOptions = {},
  ) {
    this.apiBaseUrl = options.apiBaseUrl ?? youtubeDataApiBaseUrl;
    this.http = options.http ?? fetch;
  }

  public async capabilities(): Promise<SourceCapabilities> {
    return { eventIds: false, mediaResolution: ['local_original'], polling: true };
  }

  public async poll(
    request: SourcePollRequest,
    context: SourceAdapterContext,
  ): Promise<SourcePollResult> {
    const configuration = parseYouTubeSourceConfiguration(request.configuration);
    const cursor = parseYouTubeCursor(request.cursor);
    const accessToken = await this.tokens.refreshAccessToken(configuration.accountId);
    const uploadsPlaylistId = await this.uploadsPlaylist(
      request.connectionExternalId,
      accessToken,
      context.signal,
    );
    const page = await this.playlistPage(
      uploadsPlaylistId,
      cursor.nextPageToken,
      accessToken,
      context.signal,
    );
    const candidates = page.items
      .map(parseUploadCandidate)
      .filter((candidate): candidate is YouTubeUploadCandidate => candidate !== undefined);
    const newCandidates = candidates.filter(
      (candidate) =>
        cursor.watermark === undefined || compareWatermark(candidate, cursor.watermark) > 0,
    );
    const durations =
      configuration.filters?.includeShorts === undefined
        ? new Map<string, number>()
        : await this.durations(
            newCandidates.map((candidate) => candidate.externalId),
            accessToken,
            context.signal,
          );
    const items = newCandidates
      .filter((candidate) =>
        matchesYouTubeFilters(
          candidate,
          durations.get(candidate.externalId),
          configuration.filters,
        ),
      )
      .map((candidate): SourceItemObservation => ({
        externalId: candidate.externalId,
        publishedAt: candidate.publishedAt,
        metadata: {
          description: candidate.description,
          ...(durations.has(candidate.externalId)
            ? { durationSeconds: durations.get(candidate.externalId)! }
            : {}),
          ...(candidate.privacyStatus === undefined
            ? {}
            : { privacyStatus: candidate.privacyStatus }),
          title: candidate.title,
          videoId: candidate.externalId,
        },
        media: {
          availability: 'unknown',
          resolutionStrategies: ['local_original'],
          rightsRequirement: 'connection_authorization',
        },
      }));
    const watermark = maximumWatermark(cursor.watermark, candidates);
    return {
      hasMore: page.nextPageToken !== undefined,
      items,
      cursor: encodeYouTubeCursor({
        version: 1,
        ...(watermark === undefined ? {} : { watermark }),
        ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }),
      }),
    };
  }

  private async uploadsPlaylist(
    channelId: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<string> {
    const cached = this.uploadsPlaylists.get(channelId);
    if (cached !== undefined) return cached;
    const url = new URL('channels', `${this.apiBaseUrl}/`);
    url.searchParams.set('id', channelId);
    url.searchParams.set('part', 'contentDetails');
    const body = await this.get(url, accessToken, signal, 'YOUTUBE_CHANNEL_LOOKUP_FAILED');
    const item = Array.isArray(body.items) ? safeJsonObject(body.items[0]) : undefined;
    const details = safeJsonObject(item?.contentDetails);
    const playlists = safeJsonObject(details?.relatedPlaylists);
    if (typeof playlists?.uploads !== 'string' || playlists.uploads.length === 0)
      throw platformError(
        'authorization',
        'YOUTUBE_UPLOADS_PLAYLIST_NOT_FOUND',
        'The YouTube channel uploads playlist could not be found.',
      );
    this.uploadsPlaylists.set(channelId, playlists.uploads);
    return playlists.uploads;
  }

  private async playlistPage(
    playlistId: string,
    pageToken: string | undefined,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly unknown[]; readonly nextPageToken?: string }> {
    const url = new URL('playlistItems', `${this.apiBaseUrl}/`);
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('part', 'snippet,contentDetails,status');
    url.searchParams.set('maxResults', '50');
    if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
    const body = await this.get(url, accessToken, signal, 'YOUTUBE_UPLOADS_POLL_FAILED');
    return {
      items: Array.isArray(body.items) ? body.items : [],
      ...(typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0
        ? { nextPageToken: body.nextPageToken }
        : {}),
    };
  }

  private async durations(
    ids: readonly string[],
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const url = new URL('videos', `${this.apiBaseUrl}/`);
    url.searchParams.set('id', ids.join(','));
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('maxResults', '50');
    const body = await this.get(url, accessToken, signal, 'YOUTUBE_VIDEO_METADATA_FAILED');
    const values = new Map<string, number>();
    for (const raw of Array.isArray(body.items) ? body.items : []) {
      const item = safeJsonObject(raw);
      const details = safeJsonObject(item?.contentDetails);
      if (typeof item?.id !== 'string' || typeof details?.duration !== 'string') continue;
      const duration = parseIso8601DurationSeconds(details.duration);
      if (duration !== undefined) values.set(item.id, duration);
    }
    return values;
  }

  private async get(
    url: URL,
    accessToken: string,
    signal: AbortSignal,
    code: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.http(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        method: 'GET',
        signal,
      });
    } catch (error) {
      throw platformError(
        'network',
        `${code}_NETWORK_ERROR`,
        'YouTube could not be reached while detecting uploads.',
        true,
        error,
      );
    }
    const body = await responseJson(response);
    if (!response.ok)
      throw platformError(
        response.status === 401
          ? 'authentication'
          : response.status === 403
            ? 'authorization'
            : 'remote',
        code,
        response.status === 401
          ? 'Reconnect the YouTube account to continue detecting uploads.'
          : 'YouTube could not provide upload metadata.',
        response.status === 429 || response.status >= 500,
      );
    return body ?? {};
  }
}

function parseYouTubeSourceConfiguration(
  value: Readonly<Record<string, SourceJsonValue>>,
): YouTubeSourceConfiguration {
  const accountId = value.accountId;
  if (typeof accountId !== 'string' || accountId.trim().length === 0)
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_ACCOUNT_REQUIRED',
      'Select a connected YouTube account for this source.',
    );
  const filtersValue = value.filters;
  if (filtersValue === undefined) return { accountId };
  if (filtersValue === null || typeof filtersValue !== 'object' || Array.isArray(filtersValue))
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_FILTERS_INVALID',
      'The YouTube source filters are invalid.',
    );
  const filters = filtersValue as Readonly<Record<string, SourceJsonValue>>;
  const titleRegex = filters.titleRegex;
  if (titleRegex !== undefined && (typeof titleRegex !== 'string' || titleRegex.length > 256))
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_TITLE_REGEX_INVALID',
      'The YouTube title regex is invalid.',
    );
  if (typeof titleRegex === 'string') {
    try {
      new RegExp(titleRegex, 'u');
    } catch {
      throw platformError(
        'configuration',
        'YOUTUBE_SOURCE_TITLE_REGEX_INVALID',
        'The YouTube title regex is invalid.',
      );
    }
  }
  const publishedAfter = filters.publishedAfter;
  if (
    publishedAfter !== undefined &&
    (typeof publishedAfter !== 'string' || !Number.isFinite(Date.parse(publishedAfter)))
  )
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_PUBLISHED_AFTER_INVALID',
      'The YouTube published-after filter is invalid.',
    );
  const privacyStatuses = filters.privacyStatuses;
  if (
    privacyStatuses !== undefined &&
    (!Array.isArray(privacyStatuses) ||
      privacyStatuses.some(
        (status) => status !== 'private' && status !== 'public' && status !== 'unlisted',
      ))
  )
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_PRIVACY_FILTER_INVALID',
      'The YouTube privacy filter is invalid.',
    );
  const includeShorts = filters.includeShorts;
  const shortsMaxDurationSeconds = filters.shortsMaxDurationSeconds;
  if (includeShorts !== undefined && typeof includeShorts !== 'boolean')
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_SHORTS_FILTER_INVALID',
      'The YouTube Shorts filter is invalid.',
    );
  if (
    shortsMaxDurationSeconds !== undefined &&
    (typeof shortsMaxDurationSeconds !== 'number' ||
      !Number.isInteger(shortsMaxDurationSeconds) ||
      shortsMaxDurationSeconds <= 0)
  )
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_SHORTS_FILTER_INVALID',
      'The YouTube Shorts filter is invalid.',
    );
  if (filters.titleSubstring !== undefined && typeof filters.titleSubstring !== 'string')
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_TITLE_FILTER_INVALID',
      'The YouTube title filter is invalid.',
    );
  return {
    accountId,
    filters: {
      ...(typeof includeShorts === 'boolean' ? { includeShorts } : {}),
      ...(Array.isArray(privacyStatuses)
        ? { privacyStatuses: privacyStatuses as readonly ('private' | 'public' | 'unlisted')[] }
        : {}),
      ...(typeof publishedAfter === 'string' ? { publishedAfter } : {}),
      ...(typeof shortsMaxDurationSeconds === 'number' ? { shortsMaxDurationSeconds } : {}),
      ...(typeof titleRegex === 'string' ? { titleRegex } : {}),
      ...(typeof filters.titleSubstring === 'string'
        ? { titleSubstring: filters.titleSubstring }
        : {}),
    },
  };
}

function parseYouTubeCursor(cursor: string | null): YouTubeSourceCursor {
  if (cursor === null) return { version: 1 };
  try {
    const value = JSON.parse(cursor) as Partial<YouTubeSourceCursor>;
    if (
      value.version !== 1 ||
      (value.nextPageToken !== undefined &&
        (typeof value.nextPageToken !== 'string' || value.nextPageToken.length === 0))
    )
      throw new Error();
    const watermark = value.watermark;
    if (
      watermark !== undefined &&
      (typeof watermark.externalId !== 'string' ||
        typeof watermark.publishedAt !== 'string' ||
        !Number.isFinite(Date.parse(watermark.publishedAt)))
    )
      throw new Error();
    return value as YouTubeSourceCursor;
  } catch {
    throw platformError(
      'configuration',
      'YOUTUBE_SOURCE_CURSOR_INVALID',
      'The stored YouTube source cursor is invalid.',
    );
  }
}

function encodeYouTubeCursor(cursor: YouTubeSourceCursor): string {
  return JSON.stringify(cursor);
}

function parseUploadCandidate(value: unknown): YouTubeUploadCandidate | undefined {
  const item = safeJsonObject(value);
  const snippet = safeJsonObject(item?.snippet);
  const details = safeJsonObject(item?.contentDetails);
  const status = safeJsonObject(item?.status);
  const resource = safeJsonObject(snippet?.resourceId);
  const externalId = typeof details?.videoId === 'string' ? details.videoId : resource?.videoId;
  const publishedAt =
    typeof details?.videoPublishedAt === 'string' ? details.videoPublishedAt : snippet?.publishedAt;
  if (
    typeof externalId !== 'string' ||
    typeof publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(publishedAt)) ||
    typeof snippet?.title !== 'string'
  )
    return undefined;
  return {
    externalId,
    publishedAt: new Date(publishedAt).toISOString(),
    title: snippet.title,
    description: typeof snippet.description === 'string' ? snippet.description : '',
    ...(typeof status?.privacyStatus === 'string' ? { privacyStatus: status.privacyStatus } : {}),
  };
}

function compareWatermark(
  candidate: Pick<YouTubeUploadCandidate, 'externalId' | 'publishedAt'>,
  watermark: YouTubeWatermark,
): number {
  const published = Date.parse(candidate.publishedAt) - Date.parse(watermark.publishedAt);
  return published === 0 ? candidate.externalId.localeCompare(watermark.externalId) : published;
}

function maximumWatermark(
  current: YouTubeWatermark | undefined,
  candidates: readonly YouTubeUploadCandidate[],
): YouTubeWatermark | undefined {
  let maximum = current;
  for (const candidate of candidates)
    if (maximum === undefined || compareWatermark(candidate, maximum) > 0)
      maximum = { externalId: candidate.externalId, publishedAt: candidate.publishedAt };
  return maximum;
}

function matchesYouTubeFilters(
  candidate: YouTubeUploadCandidate,
  durationSeconds: number | undefined,
  filters: YouTubeSourceConfiguration['filters'],
): boolean {
  if (filters === undefined) return true;
  if (
    filters.publishedAfter !== undefined &&
    Date.parse(candidate.publishedAt) <= Date.parse(filters.publishedAfter)
  )
    return false;
  if (filters.titleSubstring !== undefined && !candidate.title.includes(filters.titleSubstring))
    return false;
  if (
    filters.titleRegex !== undefined &&
    !new RegExp(filters.titleRegex, 'u').test(candidate.title)
  )
    return false;
  if (
    filters.privacyStatuses !== undefined &&
    (candidate.privacyStatus === undefined ||
      !filters.privacyStatuses.includes(
        candidate.privacyStatus as 'private' | 'public' | 'unlisted',
      ))
  )
    return false;
  if (filters.includeShorts !== undefined) {
    if (durationSeconds === undefined) return false;
    const isShort = durationSeconds <= (filters.shortsMaxDurationSeconds ?? 180);
    if (filters.includeShorts !== isShort) return false;
  }
  return true;
}

function parseIso8601DurationSeconds(value: string): number | undefined {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (match === null) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

export const youtubeDestinationCapabilities: DestinationCapabilities = {
  media: { kinds: ['video'] },
  metadata: {
    category: { required: false, supported: true },
    description: { maxLength: 5_000, required: false, supported: true },
    tags: { maxItemLength: 500, maxItems: 500, supported: true },
    title: { maxLength: 100, required: true, supported: true },
  },
  privacy: { supported: true, values: ['private', 'unlisted', 'public'] },
  resumableUpload: true,
  statusPolling: true,
};

export interface YouTubeUploadJobInput {
  readonly accountId: string;
  readonly mediaId: string;
  readonly metadata: PublishMetadata;
}

export interface YouTubeUploadJobHandlerOptions {
  readonly endpoints?: Partial<typeof defaultUploadEndpoints>;
  readonly http?: OAuthHttpClient;
  readonly now?: () => Date;
  readonly chunkSizeBytes?: number;
}

function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uploadInput(value: JsonValue): YouTubeUploadJobInput {
  if (!isRecord(value) || typeof value.accountId !== 'string' || typeof value.mediaId !== 'string')
    throw new JobExecutionError(
      'YOUTUBE_UPLOAD_INPUT_INVALID',
      false,
      'The YouTube upload job is invalid.',
    );
  const metadata = value.metadata;
  if (
    !isRecord(metadata) ||
    typeof metadata.title !== 'string' ||
    metadata.title.trim().length === 0
  )
    throw new JobExecutionError(
      'YOUTUBE_UPLOAD_TITLE_REQUIRED',
      false,
      'A YouTube video title is required.',
    );
  const optionalText = (name: 'category' | 'description' | 'privacy') => metadata[name];
  const tags = metadata.tags;
  if (
    (optionalText('category') !== undefined && typeof optionalText('category') !== 'string') ||
    (optionalText('description') !== undefined &&
      typeof optionalText('description') !== 'string') ||
    (optionalText('privacy') !== undefined &&
      optionalText('privacy') !== 'private' &&
      optionalText('privacy') !== 'public' &&
      optionalText('privacy') !== 'unlisted') ||
    (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')))
  )
    throw new JobExecutionError(
      'YOUTUBE_UPLOAD_INPUT_INVALID',
      false,
      'The YouTube upload metadata is invalid.',
    );
  return {
    accountId: value.accountId,
    mediaId: value.mediaId,
    metadata: {
      title: metadata.title,
      ...(typeof metadata.description === 'string' ? { description: metadata.description } : {}),
      ...(typeof metadata.category === 'string' ? { category: metadata.category } : {}),
      ...(typeof metadata.privacy === 'string'
        ? { privacy: metadata.privacy as 'private' | 'public' | 'unlisted' }
        : {}),
      ...(Array.isArray(tags) ? { tags: tags as readonly string[] } : {}),
    },
  };
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined;
}

function uploadFailure(response: Response, operation: string): JobExecutionError {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const code =
    response.status === 401
      ? 'YOUTUBE_UPLOAD_AUTH_FAILED'
      : response.status === 403
        ? 'YOUTUBE_UPLOAD_QUOTA_OR_PERMISSION_DENIED'
        : response.status === 429
          ? 'YOUTUBE_UPLOAD_RATE_LIMITED'
          : `YOUTUBE_${operation.toUpperCase()}_FAILED`;
  return new JobExecutionError(
    code,
    retryable,
    response.status === 401
      ? 'Reconnect the YouTube account to continue uploading.'
      : response.status === 403
        ? 'YouTube denied the upload. Check account permissions and API quota.'
        : retryable
          ? 'YouTube is temporarily unavailable. The upload will retry.'
          : 'YouTube rejected the upload request.',
    retryAfterMs(response),
  );
}

function parseRange(value: string | null): number {
  const match = value?.match(/(?:bytes=)?0-(\d+)/i);
  return match === null || match === undefined ? 0 : Number(match[1]) + 1;
}

async function json(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return safeJsonObject(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Durable YouTube `videos.insert` transport. The session URL is checkpointed before bytes are
 * sent; after an interruption it queries the session with the resumable status Content-Range and
 * resumes only the acknowledged suffix. Once a remote ID exists it never creates a new upload.
 */
export class YouTubeUploadJobHandler implements JobHandler {
  public readonly type = YOUTUBE_UPLOAD_JOB_TYPE;
  private readonly chunkSizeBytes: number;
  private readonly endpoints: typeof defaultUploadEndpoints;
  private readonly http: OAuthHttpClient;
  private readonly now: () => Date;

  public constructor(
    private readonly media: MediaRepository,
    private readonly checkpoints: DestinationJobRepository,
    private readonly oauth: YouTubeOAuthService,
    options: YouTubeUploadJobHandlerOptions = {},
  ) {
    this.endpoints = { ...defaultUploadEndpoints, ...options.endpoints };
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.chunkSizeBytes = options.chunkSizeBytes ?? 8 * 1024 * 1024;
    if (!Number.isInteger(this.chunkSizeBytes) || this.chunkSizeBytes < 256 * 1024)
      throw new Error('YouTube upload chunk size must be at least 256 KiB.');
  }

  public async execute(inputValue: JsonValue, context: JobHandlerContext): Promise<void> {
    const input = uploadInput(inputValue);
    const asset = this.media.list().find((candidate) => candidate.id === input.mediaId);
    if (asset === undefined || asset.state !== 'available')
      throw new JobExecutionError(
        'YOUTUBE_UPLOAD_MEDIA_UNAVAILABLE',
        false,
        'The selected media file is unavailable.',
      );
    if (asset.sizeBytes <= 0)
      throw new JobExecutionError(
        'YOUTUBE_UPLOAD_MEDIA_EMPTY',
        false,
        'The selected media file is empty.',
      );

    let checkpoint = this.checkpoints.find(context.jobId) ?? {
      jobId: context.jobId,
      destinationId: 'youtube',
      remoteStatus: 'uploading',
      uploadedBytes: 0,
      updatedAt: this.now(),
    };
    if (checkpoint.remoteId !== undefined) return this.poll(checkpoint, input.accountId, context);

    const accessToken = await this.accessToken(input.accountId);
    if (checkpoint.resumableSessionUrl === undefined) {
      checkpoint = await this.startSession(
        input,
        asset.sizeBytes,
        asset.path,
        accessToken,
        checkpoint,
      );
    } else {
      const recovered = await this.resumeOffset(checkpoint, asset.sizeBytes, accessToken);
      if (recovered === undefined) {
        checkpoint = this.save(this.withoutSession(checkpoint, { uploadedBytes: 0 }));
        checkpoint = await this.startSession(
          input,
          asset.sizeBytes,
          asset.path,
          accessToken,
          checkpoint,
        );
      } else {
        checkpoint =
          recovered === asset.sizeBytes
            ? this.checkpoints.find(context.jobId)!
            : this.save({ ...checkpoint, uploadedBytes: recovered });
      }
    }

    while (checkpoint.uploadedBytes < asset.sizeBytes) {
      if (context.signal.aborted)
        throw new JobExecutionError(
          'YOUTUBE_UPLOAD_CANCELLED',
          false,
          'The YouTube upload was cancelled.',
        );
      const start = checkpoint.uploadedBytes;
      const end = Math.min(asset.sizeBytes - 1, start + this.chunkSizeBytes - 1);
      let response: Response;
      try {
        response = await this.http(checkpoint.resumableSessionUrl!, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${asset.sizeBytes}`,
            'Content-Type': this.mimeType(asset.path),
          },
          body: createReadStream(asset.path, { start, end }),
          duplex: 'half',
          signal: context.signal,
        } as RequestInit);
      } catch {
        throw new JobExecutionError(
          'YOUTUBE_UPLOAD_NETWORK_ERROR',
          true,
          'YouTube could not be reached. The upload will resume.',
        );
      }
      if (response.status === 308) {
        checkpoint = this.save({
          ...checkpoint,
          uploadedBytes: parseRange(response.headers.get('range')),
        });
        continue;
      }
      if (!response.ok) throw uploadFailure(response, 'upload');
      const body = await json(response);
      if (typeof body?.id !== 'string')
        throw new JobExecutionError(
          'YOUTUBE_UPLOAD_RESPONSE_INVALID',
          true,
          'YouTube returned an invalid upload response.',
        );
      checkpoint = this.save({
        ...this.withoutSession(checkpoint),
        remoteId: body.id,
        remoteUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(body.id)}`,
        remoteStatus: 'processing',
        uploadedBytes: asset.sizeBytes,
      });
    }
    return this.poll(checkpoint, input.accountId, context);
  }

  private async startSession(
    input: YouTubeUploadJobInput,
    sizeBytes: number,
    path: string,
    accessToken: string,
    checkpoint: DestinationJobRecord,
  ): Promise<DestinationJobRecord> {
    const url = new URL(this.endpoints.upload);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('part', 'snippet,status');
    let response: Response;
    try {
      response = await this.http(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(sizeBytes),
          'X-Upload-Content-Type': this.mimeType(path),
        },
        body: JSON.stringify({
          snippet: {
            title: input.metadata.title,
            ...(input.metadata.description === undefined
              ? {}
              : { description: input.metadata.description }),
            ...(input.metadata.category === undefined
              ? {}
              : { categoryId: input.metadata.category }),
            ...(input.metadata.tags === undefined ? {} : { tags: input.metadata.tags }),
          },
          status: { privacyStatus: input.metadata.privacy ?? 'private' },
        }),
      });
    } catch {
      throw new JobExecutionError(
        'YOUTUBE_SESSION_NETWORK_ERROR',
        true,
        'YouTube could not be reached. The upload will retry.',
      );
    }
    if (!response.ok) throw uploadFailure(response, 'session');
    const sessionUrl = response.headers.get('location');
    if (sessionUrl === null || !sessionUrl.startsWith('https://'))
      throw new JobExecutionError(
        'YOUTUBE_SESSION_URL_MISSING',
        true,
        'YouTube did not return an upload session.',
      );
    return this.save({ ...checkpoint, resumableSessionUrl: sessionUrl, uploadedBytes: 0 });
  }

  /** Returns undefined only for an expired session, which is safe to replace before any new insert. */
  private async resumeOffset(
    checkpoint: DestinationJobRecord,
    sizeBytes: number,
    accessToken: string,
  ): Promise<number | undefined> {
    let response: Response;
    try {
      response = await this.http(checkpoint.resumableSessionUrl!, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Length': '0',
          'Content-Range': `bytes */${sizeBytes}`,
        },
      });
    } catch {
      throw new JobExecutionError(
        'YOUTUBE_RESUME_NETWORK_ERROR',
        true,
        'YouTube could not be reached. The upload will resume.',
      );
    }
    if (response.status === 404) return undefined;
    if (response.status === 308) return parseRange(response.headers.get('range'));
    if (!response.ok) throw uploadFailure(response, 'resume');
    const body = await json(response);
    if (typeof body?.id !== 'string')
      throw new JobExecutionError(
        'YOUTUBE_RESUME_RESPONSE_INVALID',
        true,
        'YouTube returned an invalid upload response.',
      );
    this.save({
      ...this.withoutSession(checkpoint),
      remoteId: body.id,
      remoteUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(body.id)}`,
      remoteStatus: 'processing',
      uploadedBytes: sizeBytes,
    });
    return sizeBytes;
  }

  private async poll(
    checkpoint: DestinationJobRecord,
    accountId: string,
    context: JobHandlerContext,
  ): Promise<void> {
    if (checkpoint.remoteId === undefined)
      throw new JobExecutionError(
        'YOUTUBE_REMOTE_ID_MISSING',
        true,
        'YouTube upload status is not available yet.',
      );
    const url = new URL(this.endpoints.videos);
    url.searchParams.set('part', 'processingDetails');
    url.searchParams.set('id', checkpoint.remoteId);
    let response: Response;
    try {
      response = await this.http(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${await this.accessToken(accountId)}` },
        signal: context.signal,
      });
    } catch {
      throw new JobExecutionError(
        'YOUTUBE_PROCESSING_NETWORK_ERROR',
        true,
        'YouTube processing status could not be loaded.',
      );
    }
    if (!response.ok) throw uploadFailure(response, 'processing_status');
    const body = await json(response);
    const item = Array.isArray(body?.items) ? safeJsonObject(body.items[0]) : undefined;
    const details = safeJsonObject(item?.processingDetails);
    const status = details?.processingStatus;
    if (status === 'processing') {
      this.save({ ...checkpoint, remoteStatus: 'processing' });
      throw new JobExecutionError(
        'YOUTUBE_PROCESSING',
        true,
        'YouTube is still processing the uploaded video.',
      );
    }
    if (status === 'succeeded') {
      this.save({ ...checkpoint, remoteStatus: 'succeeded' });
      return;
    }
    if (status === 'failed') {
      this.save({ ...checkpoint, remoteStatus: 'failed' });
      throw new JobExecutionError(
        'YOUTUBE_PROCESSING_FAILED',
        false,
        'YouTube failed to process the uploaded video.',
      );
    }
    if (status === 'terminated') {
      this.save({ ...checkpoint, remoteStatus: 'terminated' });
      throw new JobExecutionError(
        'YOUTUBE_PROCESSING_TERMINATED',
        false,
        'YouTube processing status is no longer available.',
      );
    }
    throw new JobExecutionError(
      'YOUTUBE_PROCESSING_RESPONSE_INVALID',
      true,
      'YouTube returned an invalid processing status.',
    );
  }

  private async accessToken(accountId: string): Promise<string> {
    try {
      return await this.oauth.refreshAccessToken(accountId);
    } catch (error) {
      if (error instanceof PlatformError)
        throw new JobExecutionError(error.code, error.retryable, error.publicMessage);
      throw error;
    }
  }

  private mimeType(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    return 'application/octet-stream';
  }

  private save(record: Omit<DestinationJobRecord, 'updatedAt'>): DestinationJobRecord {
    return this.checkpoints.save({ ...record, updatedAt: this.now() });
  }

  private withoutSession(
    checkpoint: DestinationJobRecord,
    changes: Partial<Omit<DestinationJobRecord, 'updatedAt' | 'resumableSessionUrl'>> = {},
  ): Omit<DestinationJobRecord, 'updatedAt'> {
    const record: Record<string, unknown> = { ...checkpoint };
    Reflect.deleteProperty(record, 'resumableSessionUrl');
    Reflect.deleteProperty(record, 'updatedAt');
    return { ...record, ...changes } as Omit<DestinationJobRecord, 'updatedAt'>;
  }
}

function safeJsonObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function responseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return safeJsonObject(await response.json());
  } catch {
    return undefined;
  }
}

function stateHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function capabilitiesForScopes(scopes: ReadonlySet<string>): readonly AccountCapability[] {
  const capabilities: AccountCapability[] = [];
  if (
    scopes.has(YOUTUBE_READONLY_SCOPE) ||
    scopes.has(YOUTUBE_FULL_SCOPE) ||
    scopes.has(YOUTUBE_FORCE_SSL_SCOPE)
  ) {
    capabilities.push('youtube.identity.read');
  }
  if (
    scopes.has(YOUTUBE_UPLOAD_SCOPE) ||
    scopes.has(YOUTUBE_FULL_SCOPE) ||
    scopes.has(YOUTUBE_FORCE_SSL_SCOPE)
  ) {
    capabilities.push('youtube.video.upload');
  }
  return capabilities;
}

function platformError(
  category: ConstructorParameters<typeof PlatformError>[0]['category'],
  code: string,
  publicMessage: string,
  retryable = false,
  cause?: unknown,
): PlatformError {
  return new PlatformError({
    category,
    code,
    publicMessage,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** OAuth/account application service shared by HTTP and CLI composition roots. */
export class YouTubeOAuthService {
  private readonly endpoints: YouTubeOAuthEndpoints;
  private readonly flowLifetimeMs: number;
  private readonly http: OAuthHttpClient;
  private readonly now: () => Date;

  public constructor(
    private readonly accounts: AccountRepository,
    private readonly requests: OAuthAuthorizationRequestRepository,
    private readonly secrets: SecretStore,
    private readonly appUrl: URL,
    options: YouTubeOAuthServiceOptions = {},
  ) {
    this.endpoints = { ...defaultEndpoints, ...options.endpoints };
    this.flowLifetimeMs = options.flowLifetimeMs ?? 10 * 60 * 1_000;
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public async configureCredentials(input: ConfigureYouTubeCredentialsInput): Promise<void> {
    const clientId = input.clientId.trim();
    if (clientId.length === 0)
      throw platformError(
        'configuration',
        'YOUTUBE_CLIENT_ID_REQUIRED',
        'A Google OAuth client ID is required.',
      );
    const previousClientId = await this.secrets.get(clientIdReference);
    if (input.clientSecret !== undefined && input.clientSecret.trim().length > 0) {
      await this.secrets.set(clientSecretReference, input.clientSecret.trim());
    } else if (previousClientId !== undefined && previousClientId !== clientId) {
      await this.secrets.delete(clientSecretReference);
    }
    await this.secrets.set(clientIdReference, clientId);
    if (previousClientId !== undefined && previousClientId !== clientId)
      this.accounts.setProviderStatus('youtube', 'reauthorization_required', this.now());
  }

  public async credentialStatus(): Promise<YouTubeCredentialStatus> {
    const [clientId, clientSecret] = await Promise.all([
      this.secrets.get(clientIdReference),
      this.secrets.get(clientSecretReference),
    ]);
    return {
      configured: clientId !== undefined,
      clientSecretConfigured: clientSecret !== undefined,
      redirectUri: this.redirectUri(),
    };
  }

  public listAccounts(): readonly ConnectedAccount[] {
    return this.accounts.list();
  }

  public async removeAccount(id: string): Promise<ConnectedAccount | undefined> {
    const existing = this.accounts.findById(id);
    if (existing === undefined || existing.provider !== 'youtube') return undefined;
    await this.secrets.delete(youtubeRefreshTokenReference(id));
    return this.accounts.remove(id);
  }

  public async beginAuthorization(browserBinding: string): Promise<YouTubeOAuthStart> {
    if (browserBinding.length === 0)
      throw platformError(
        'authentication',
        'YOUTUBE_OAUTH_SESSION_REQUIRED',
        'A local browser session is required to connect YouTube.',
      );
    const credentials = await this.requireCredentials();
    const now = this.now();
    const expired = this.requests.deleteExpired(now);
    await Promise.all(expired.map((request) => this.secrets.delete(verifierReference(request.id))));

    const requestId = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const request: OAuthAuthorizationRequest = {
      id: requestId,
      provider: 'youtube',
      stateHash: stateHash(state),
      bindingHash: stateHash(browserBinding),
      redirectUri: this.redirectUri(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.flowLifetimeMs),
    };
    await this.secrets.set(verifierReference(requestId), verifier);
    try {
      this.requests.create(request);
    } catch (error) {
      await this.secrets.delete(verifierReference(requestId));
      throw error;
    }

    const authorizationUrl = new URL(this.endpoints.authorization);
    authorizationUrl.searchParams.set('client_id', credentials.clientId);
    authorizationUrl.searchParams.set('redirect_uri', request.redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', `${YOUTUBE_READONLY_SCOPE} ${YOUTUBE_UPLOAD_SCOPE}`);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: authorizationUrl.toString(), expiresAt: request.expiresAt };
  }

  public async completeAuthorization(input: YouTubeOAuthCallbackInput): Promise<ConnectedAccount> {
    if (input.state === undefined || input.state.length === 0)
      throw platformError(
        'authentication',
        'YOUTUBE_OAUTH_STATE_INVALID',
        'The YouTube authorization response has invalid state. Start the connection again.',
      );
    const request =
      input.browserBinding === undefined
        ? undefined
        : this.requests.consumeByStateHash(stateHash(input.state), stateHash(input.browserBinding));
    if (request === undefined)
      throw platformError(
        'authentication',
        'YOUTUBE_OAUTH_STATE_INVALID',
        'The YouTube authorization response has invalid or already-used state.',
      );
    const reference = verifierReference(request.id);
    try {
      if (request.expiresAt.getTime() <= this.now().getTime())
        throw platformError(
          'authentication',
          'YOUTUBE_OAUTH_STATE_EXPIRED',
          'The YouTube authorization request expired. Start the connection again.',
        );
      if (input.error !== undefined)
        throw platformError(
          'authorization',
          'YOUTUBE_OAUTH_DENIED',
          'YouTube authorization was not granted.',
        );
      if (input.code === undefined || input.code.length === 0)
        throw platformError(
          'authentication',
          'YOUTUBE_OAUTH_CODE_MISSING',
          'The YouTube authorization response did not include a code.',
        );
      const verifier = await this.secrets.get(reference);
      if (verifier === undefined)
        throw platformError(
          'authentication',
          'YOUTUBE_OAUTH_VERIFIER_MISSING',
          'The YouTube authorization request cannot be resumed. Start the connection again.',
        );
      const credentials = await this.requireCredentials();
      const token = await this.exchangeCode(input.code, verifier, request.redirectUri, credentials);
      if (token.refreshToken === undefined)
        throw platformError(
          'authentication',
          'YOUTUBE_REFRESH_TOKEN_MISSING',
          'Google did not return a refresh token. Remove OpenRepurpose access in Google and connect again.',
        );
      const scopes = new Set(token.scopes ?? []);
      const capabilities = capabilitiesForScopes(scopes);
      if (!capabilities.includes('youtube.identity.read'))
        throw platformError(
          'authorization',
          'YOUTUBE_IDENTITY_SCOPE_MISSING',
          'Channel read access is required to identify the connected YouTube account.',
        );
      const identity = await this.loadChannelIdentity(token.accessToken);
      const now = this.now();
      const account = this.accounts.upsert({
        id: randomUUID(),
        provider: 'youtube',
        externalId: identity.id,
        displayName: identity.title,
        status: 'connected',
        capabilities,
        connectedAt: now,
        updatedAt: now,
      });
      try {
        await this.secrets.set(youtubeRefreshTokenReference(account.id), token.refreshToken);
      } catch (error) {
        this.accounts.setStatus(account.id, 'reauthorization_required', now);
        throw error;
      }
      return account;
    } finally {
      await this.secrets.delete(reference);
    }
  }

  /** Refreshes access server-side; Packet 8 can reuse this without exposing tokens to jobs/UI. */
  public async refreshAccessToken(accountId: string): Promise<string> {
    const account = this.accounts.findById(accountId);
    if (account === undefined || account.provider !== 'youtube')
      throw platformError(
        'configuration',
        'YOUTUBE_ACCOUNT_NOT_FOUND',
        'The YouTube account was not found.',
      );
    const refreshToken = await this.secrets.get(youtubeRefreshTokenReference(accountId));
    if (refreshToken === undefined)
      throw platformError(
        'authentication',
        'YOUTUBE_REFRESH_TOKEN_MISSING',
        'Reconnect the YouTube account to continue.',
      );
    const credentials = await this.requireCredentials();
    const form = new URLSearchParams({
      client_id: credentials.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (credentials.clientSecret !== undefined) form.set('client_secret', credentials.clientSecret);
    const response = await this.postToken(form);
    if (!response.response.ok) {
      const remoteCode =
        typeof response.body?.error === 'string' ? response.body.error : 'token_refresh_failed';
      if (remoteCode === 'invalid_grant')
        this.accounts.setStatus(accountId, 'reauthorization_required', this.now());
      throw platformError(
        remoteCode === 'invalid_client' ? 'configuration' : 'authentication',
        remoteCode === 'invalid_client'
          ? 'YOUTUBE_OAUTH_CLIENT_INVALID'
          : 'YOUTUBE_TOKEN_REFRESH_FAILED',
        remoteCode === 'invalid_client'
          ? 'The configured Google OAuth client credentials were rejected.'
          : 'The YouTube account must be reconnected.',
        false,
      );
    }
    const token = this.parseTokenResponse(response.body, false);
    if (token.refreshToken !== undefined)
      await this.secrets.set(youtubeRefreshTokenReference(accountId), token.refreshToken);
    return token.accessToken;
  }

  private async exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string,
    credentials: YouTubeCredentials,
  ): Promise<TokenResponse> {
    const form = new URLSearchParams({
      client_id: credentials.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (credentials.clientSecret !== undefined) form.set('client_secret', credentials.clientSecret);
    const result = await this.postToken(form);
    if (!result.response.ok)
      throw platformError(
        result.response.status === 401 ? 'authentication' : 'remote',
        'YOUTUBE_TOKEN_EXCHANGE_FAILED',
        'Google rejected the YouTube authorization response. Start the connection again.',
        result.response.status >= 500,
      );
    return this.parseTokenResponse(result.body, true);
  }

  private async loadChannelIdentity(
    accessToken: string,
  ): Promise<{ readonly id: string; readonly title: string }> {
    const url = new URL(this.endpoints.channels);
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '50');
    let response: Response;
    try {
      response = await this.http(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        method: 'GET',
      });
    } catch (error) {
      throw platformError(
        'network',
        'YOUTUBE_IDENTITY_NETWORK_ERROR',
        'YouTube could not be reached while loading the channel identity.',
        true,
        error,
      );
    }
    const body = await responseJson(response);
    if (!response.ok)
      throw platformError(
        response.status === 401 ? 'authentication' : 'remote',
        'YOUTUBE_IDENTITY_FAILED',
        'The connected YouTube channel identity could not be loaded.',
        response.status >= 500,
      );
    const items = Array.isArray(body?.items) ? body.items : [];
    const item = safeJsonObject(items[0]);
    const snippet = safeJsonObject(item?.snippet);
    if (typeof item?.id !== 'string' || typeof snippet?.title !== 'string')
      throw platformError(
        'authorization',
        'YOUTUBE_CHANNEL_NOT_FOUND',
        'No YouTube channel was found for the authorized Google account.',
      );
    return { id: item.id, title: snippet.title };
  }

  private parseTokenResponse(
    body: Record<string, unknown> | undefined,
    requireRefreshToken: boolean,
  ): TokenResponse {
    if (
      typeof body?.access_token !== 'string' ||
      typeof body.expires_in !== 'number' ||
      (requireRefreshToken && typeof body.refresh_token !== 'string')
    ) {
      throw platformError(
        'remote',
        'YOUTUBE_TOKEN_RESPONSE_INVALID',
        'Google returned an invalid OAuth token response.',
      );
    }
    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.scope === 'string'
        ? { scopes: body.scope.split(' ').filter((scope) => scope.length > 0) }
        : {}),
    };
  }

  private async postToken(form: URLSearchParams): Promise<{
    readonly body: Record<string, unknown> | undefined;
    readonly response: Response;
  }> {
    let response: Response;
    try {
      response = await this.http(this.endpoints.token, {
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      });
    } catch (error) {
      throw platformError(
        'network',
        'YOUTUBE_TOKEN_NETWORK_ERROR',
        'Google OAuth could not be reached.',
        true,
        error,
      );
    }
    return { response, body: await responseJson(response) };
  }

  private redirectUri(): string {
    return new URL('/api/accounts/youtube/oauth/callback', this.appUrl).toString();
  }

  private async requireCredentials(): Promise<YouTubeCredentials> {
    const [clientId, clientSecret] = await Promise.all([
      this.secrets.get(clientIdReference),
      this.secrets.get(clientSecretReference),
    ]);
    if (clientId === undefined)
      throw platformError(
        'configuration',
        'YOUTUBE_CREDENTIALS_NOT_CONFIGURED',
        'Configure Google OAuth credentials before connecting YouTube.',
      );
    return { clientId, ...(clientSecret === undefined ? {} : { clientSecret }) };
  }
}
