import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type {
  DestinationJobRecord,
  DestinationJobRepository,
  JobHandler,
  JobHandlerContext,
  JsonValue,
  MediaAsset,
  MediaRepository,
  MetaCredential,
  MetaCredentialRepository,
  MetaPublishTarget,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
} from '@openrepurpose/core';
import { JobExecutionError } from '@openrepurpose/core';
import type { SecretReference, SecretStore } from '@openrepurpose/platform-sdk';
import { PlatformError } from '@openrepurpose/platform-sdk';

export const META_SCOPES = [
  'public_profile',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
] as const;
export interface MetaHttpClient {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}
export interface MetaCredentialStatus {
  readonly configured: boolean;
  readonly redirectUri: string;
}
export interface MetaOAuthServiceOptions {
  readonly endpoints?: Partial<MetaEndpoints>;
  readonly http?: MetaHttpClient;
  readonly now?: () => Date;
}
export interface MetaOAuthStart {
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
}
export interface MetaOAuthCallbackInput {
  readonly browserBinding?: string;
  readonly code?: string;
  readonly error?: string;
  readonly state?: string;
}
export interface MetaEndpoints {
  readonly authorization: string;
  readonly graph: string;
  readonly token: string;
}
interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
}
interface TokenBundle {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}
interface Identity {
  readonly id: string;
  readonly name: string;
}

const clientIdReference: SecretReference = {
  name: 'client-id',
  ownerId: 'meta',
  scope: 'application',
};
const clientSecretReference: SecretReference = {
  name: 'client-secret',
  ownerId: 'meta',
  scope: 'application',
};
export function metaTokenBundleReference(credentialId: string): SecretReference {
  return { name: 'meta-token-bundle', ownerId: credentialId, scope: 'account' };
}
export function metaPageTokenReference(targetId: string): SecretReference {
  return { name: 'meta-page-token', ownerId: targetId, scope: 'account' };
}
/** Meta's returned upload URI is treated as secret material and is never checkpointed in SQLite. */
export function instagramUploadUriReference(jobId: string): SecretReference {
  return {
    name: 'instagram-upload-uri',
    ownerId: `instagram-upload:${jobId}`,
    scope: 'application',
  };
}
/** Facebook's Page Reels upload URL can resume an in-progress upload and is secret material. */
export function facebookReelsUploadUriReference(jobId: string): SecretReference {
  return {
    name: 'facebook-reels-upload-uri',
    ownerId: `facebook-reels-upload:${jobId}`,
    scope: 'application',
  };
}
const defaults: MetaEndpoints = {
  authorization: 'https://www.facebook.com/v26.0/dialog/oauth',
  graph: 'https://graph.facebook.com/v26.0',
  token: 'https://graph.facebook.com/v26.0/oauth/access_token',
};
function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
async function body(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return object(await response.json());
  } catch {
    return undefined;
  }
}
function failure(
  category: ConstructorParameters<typeof PlatformError>[0]['category'],
  code: string,
  publicMessage: string,
): PlatformError {
  return new PlatformError({ category, code, publicMessage, retryable: false });
}

/** OAuth, expiring token renewal, and Page/Instagram target discovery. No publishing transport lives here. */
export class MetaOAuthService {
  private readonly endpoints: MetaEndpoints;
  private readonly http: MetaHttpClient;
  private readonly now: () => Date;
  public constructor(
    private readonly credentials: MetaCredentialRepository,
    private readonly requests: OAuthAuthorizationRequestRepository,
    private readonly secrets: SecretStore,
    private readonly appUrl: URL,
    options: MetaOAuthServiceOptions = {},
  ) {
    this.endpoints = { ...defaults, ...options.endpoints };
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  public async configureCredentials(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!clientId || !clientSecret)
      throw failure(
        'configuration',
        'META_CREDENTIALS_REQUIRED',
        'A Meta app ID and app secret are required.',
      );
    const old = await this.secrets.get(clientIdReference);
    await this.secrets.set(clientIdReference, clientId);
    await this.secrets.set(clientSecretReference, clientSecret);
    if (old !== undefined && old !== clientId)
      for (const item of this.credentials.listCredentials())
        this.credentials.setCredentialStatus(item.id, 'reauthorization_required', this.now());
  }
  public async credentialStatus(): Promise<MetaCredentialStatus> {
    return {
      configured:
        (await this.secrets.get(clientIdReference)) !== undefined &&
        (await this.secrets.get(clientSecretReference)) !== undefined,
      redirectUri: this.redirectUri(),
    };
  }
  public listCredentials(): readonly MetaCredential[] {
    return this.credentials.listCredentials();
  }
  public listTargets(): readonly MetaPublishTarget[] {
    return this.credentials.listTargets();
  }
  public async beginAuthorization(browserBinding: string): Promise<MetaOAuthStart> {
    if (!browserBinding)
      throw failure(
        'authentication',
        'META_OAUTH_SESSION_REQUIRED',
        'A local browser session is required to connect Meta.',
      );
    const config = await this.requireCredentials();
    const now = this.now();
    this.requests.deleteExpired(now);
    const state = randomBytes(32).toString('base64url');
    const request: OAuthAuthorizationRequest = {
      id: randomUUID(),
      provider: 'meta',
      stateHash: hash(state),
      bindingHash: hash(browserBinding),
      redirectUri: this.redirectUri(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    };
    this.requests.create(request);
    const url = new URL(this.endpoints.authorization);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', META_SCOPES.join(','));
    return { authorizationUrl: url.toString(), expiresAt: request.expiresAt };
  }
  public async completeAuthorization(input: MetaOAuthCallbackInput): Promise<MetaCredential> {
    if (!input.state || !input.browserBinding)
      throw failure(
        'authentication',
        'META_OAUTH_STATE_INVALID',
        'The Meta authorization response has invalid state. Start the connection again.',
      );
    const request = this.requests.consumeByStateHash(hash(input.state), hash(input.browserBinding));
    if (request?.provider !== 'meta' || request.expiresAt <= this.now())
      throw failure(
        'authentication',
        'META_OAUTH_STATE_INVALID',
        'The Meta authorization response has invalid or expired state.',
      );
    if (input.error !== undefined)
      throw failure('authorization', 'META_OAUTH_DENIED', 'Meta authorization was not granted.');
    if (!input.code)
      throw failure(
        'authentication',
        'META_OAUTH_CODE_MISSING',
        'The Meta authorization response did not include a code.',
      );
    const token = await this.exchangeCode(input.code, request.redirectUri);
    const identity = await this.identity(token.accessToken);
    const scopes = await this.grantedScopes(token.accessToken);
    const now = this.now();
    const credential = this.credentials.upsertCredential({
      id: randomUUID(),
      externalId: identity.id,
      displayName: identity.name,
      status: 'connected',
      scopes,
      tokenExpiresAt: new Date(token.expiresAt),
      connectedAt: now,
      updatedAt: now,
    });
    await this.secrets.set(metaTokenBundleReference(credential.id), JSON.stringify(token));
    await this.discoverTargets(credential.id);
    return credential;
  }
  public async refreshAccessToken(credentialId: string): Promise<string> {
    const credential = this.requireCredential(credentialId);
    const current = await this.readBundle(credentialId);
    const config = await this.requireCredentials();
    const url = new URL(this.endpoints.token);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('client_secret', config.clientSecret);
    url.searchParams.set('fb_exchange_token', current.accessToken);
    const response = await this.http(url);
    const result = await body(response);
    if (!response.ok || typeof result?.access_token !== 'string') {
      this.credentials.setCredentialStatus(credentialId, 'reauthorization_required', this.now());
      throw failure(
        'authentication',
        'META_TOKEN_REFRESH_FAILED',
        'The Meta account must be reconnected.',
      );
    }
    const expires = typeof result.expires_in === 'number' ? result.expires_in : 60 * 24 * 60 * 60;
    const refreshed: TokenBundle = {
      accessToken: result.access_token,
      expiresAt: this.now().getTime() + expires * 1000,
      scopes: current.scopes,
    };
    await this.secrets.set(metaTokenBundleReference(credentialId), JSON.stringify(refreshed));
    this.credentials.upsertCredential({
      ...credential,
      status: 'connected',
      tokenExpiresAt: new Date(refreshed.expiresAt),
      updatedAt: this.now(),
    });
    return refreshed.accessToken;
  }
  public async discoverTargets(credentialId: string): Promise<readonly MetaPublishTarget[]> {
    const token = await this.usableToken(credentialId);
    const url = new URL(`${this.endpoints.graph}/me/accounts`);
    url.searchParams.set(
      'fields',
      'id,name,tasks,access_token,instagram_business_account{id,name,username}',
    );
    url.searchParams.set('access_token', token);
    const response = await this.http(url);
    const result = await body(response);
    if (!response.ok || !Array.isArray(result?.data))
      throw failure(
        'authorization',
        'META_TARGET_DISCOVERY_FAILED',
        'Meta targets could not be discovered. Reconnect and verify Page access.',
      );
    const now = this.now();
    const credential = this.requireCredential(credentialId);
    const targets: MetaPublishTarget[] = [];
    for (const value of result.data) {
      const raw = object(value);
      if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') continue;
      const tasks = Array.isArray(raw.tasks)
        ? raw.tasks.filter((task): task is string => typeof task === 'string')
        : [];
      const available =
        tasks.includes('CREATE_CONTENT') && credential.scopes.includes('pages_manage_posts');
      const blocker = available
        ? undefined
        : 'The Page must grant CREATE_CONTENT and the Meta app must be granted pages_manage_posts.';
      const base = {
        id: randomUUID(),
        credentialId,
        pageId: raw.id,
        enabled: available,
        availability: available ? ('available' as const) : ('blocked' as const),
        ...(blocker === undefined ? {} : { blocker }),
        updatedAt: now,
      };
      const pageTarget = this.credentials.upsertTarget({
        ...base,
        kind: 'facebook_page',
        externalId: raw.id,
        displayName: raw.name,
      });
      targets.push(pageTarget);
      if (typeof raw.access_token === 'string')
        await this.secrets.set(metaPageTokenReference(pageTarget.id), raw.access_token);
      const instagram = object(raw.instagram_business_account);
      if (instagram && typeof instagram.id === 'string') {
        const username = typeof instagram.username === 'string' ? instagram.username : undefined;
        const name =
          typeof instagram.name === 'string'
            ? instagram.name
            : username === undefined
              ? `Instagram ${instagram.id}`
              : `@${username}`;
        const instagramAvailable =
          available &&
          credential.scopes.includes('instagram_basic') &&
          credential.scopes.includes('instagram_content_publish');
        const instagramBlocker = instagramAvailable
          ? undefined
          : 'Instagram publishing needs the linked Page content task plus instagram_basic and instagram_content_publish.';
        const instagramTarget = this.credentials.upsertTarget({
          ...base,
          id: randomUUID(),
          kind: 'instagram_professional',
          externalId: instagram.id,
          displayName: name,
          enabled: instagramAvailable,
          availability: instagramAvailable ? 'available' : 'blocked',
          ...(instagramBlocker === undefined ? {} : { blocker: instagramBlocker }),
          ...(username === undefined ? {} : { username }),
        });
        targets.push(instagramTarget);
        if (typeof raw.access_token === 'string')
          await this.secrets.set(metaPageTokenReference(instagramTarget.id), raw.access_token);
      }
    }
    return targets;
  }
  public setTargetEnabled(id: string, enabled: boolean): boolean {
    return this.credentials.setTargetEnabled(id, enabled, this.now());
  }
  private async usableToken(id: string): Promise<string> {
    const credential = this.requireCredential(id);
    if (credential.tokenExpiresAt.getTime() > this.now().getTime() + 5 * 60_000)
      return (await this.readBundle(id)).accessToken;
    return this.refreshAccessToken(id);
  }
  private requireCredential(id: string): MetaCredential {
    const credential = this.credentials.findCredential(id);
    if (!credential)
      throw failure(
        'configuration',
        'META_CREDENTIAL_NOT_FOUND',
        'The Meta credential was not found.',
      );
    if (credential.status !== 'connected')
      throw failure(
        'authentication',
        'META_REAUTHORIZATION_REQUIRED',
        'Reconnect the Meta account to continue.',
      );
    return credential;
  }
  private async requireCredentials(): Promise<Credentials> {
    const [clientId, clientSecret] = await Promise.all([
      this.secrets.get(clientIdReference),
      this.secrets.get(clientSecretReference),
    ]);
    if (!clientId || !clientSecret)
      throw failure(
        'configuration',
        'META_CREDENTIALS_REQUIRED',
        'Configure a Meta app ID and app secret first.',
      );
    return { clientId, clientSecret };
  }
  private async exchangeCode(code: string, redirectUri: string): Promise<TokenBundle> {
    const config = await this.requireCredentials();
    const url = new URL(this.endpoints.token);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('client_secret', config.clientSecret);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code', code);
    const response = await this.http(url);
    const result = await body(response);
    if (!response.ok || typeof result?.access_token !== 'string')
      throw failure(
        'authentication',
        'META_TOKEN_EXCHANGE_FAILED',
        'Meta rejected the authorization response. Start the connection again.',
      );
    const expires = typeof result.expires_in === 'number' ? result.expires_in : 60 * 24 * 60 * 60;
    return {
      accessToken: result.access_token,
      expiresAt: this.now().getTime() + expires * 1000,
      scopes: META_SCOPES,
    };
  }
  private async identity(accessToken: string): Promise<Identity> {
    const url = new URL(`${this.endpoints.graph}/me`);
    url.searchParams.set('fields', 'id,name');
    url.searchParams.set('access_token', accessToken);
    const response = await this.http(url);
    const result = await body(response);
    if (!response.ok || typeof result?.id !== 'string' || typeof result.name !== 'string')
      throw failure(
        'authentication',
        'META_IDENTITY_LOOKUP_FAILED',
        'Meta did not return an account identity.',
      );
    return { id: result.id, name: result.name };
  }
  private async grantedScopes(accessToken: string): Promise<readonly string[]> {
    const url = new URL(`${this.endpoints.graph}/me/permissions`);
    url.searchParams.set('access_token', accessToken);
    const response = await this.http(url);
    const result = await body(response);
    if (!response.ok || !Array.isArray(result?.data)) return [];
    return result.data.flatMap((value) => {
      const permission = object(value);
      return permission?.status === 'granted' && typeof permission.permission === 'string'
        ? [permission.permission]
        : [];
    });
  }
  private async readBundle(id: string): Promise<TokenBundle> {
    const value = await this.secrets.get(metaTokenBundleReference(id));
    if (!value)
      throw failure(
        'authentication',
        'META_TOKEN_MISSING',
        'Reconnect the Meta account to continue.',
      );
    try {
      const parsed = object(JSON.parse(value));
      if (
        !parsed ||
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.expiresAt !== 'number' ||
        !Array.isArray(parsed.scopes)
      )
        throw new Error();
      return {
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt,
        scopes: parsed.scopes.filter((scope): scope is string => typeof scope === 'string'),
      };
    } catch {
      throw failure(
        'authentication',
        'META_TOKEN_INVALID',
        'Reconnect the Meta account to continue.',
      );
    }
  }
  private redirectUri(): string {
    return new URL('/api/accounts/meta/oauth/callback', this.appUrl).toString();
  }
}

export const INSTAGRAM_REELS_JOB_TYPE = 'instagram.reels.publish';

export interface InstagramReelsJobInput {
  readonly mediaId: string;
  readonly targetId: string;
  readonly metadata?: {
    readonly caption?: string;
    readonly shareToFeed?: boolean;
  };
}

export interface InstagramReelsJobHandlerOptions {
  readonly endpoints?: Partial<InstagramReelsEndpoints>;
  readonly http?: MetaHttpClient;
  readonly now?: () => Date;
}

export interface InstagramReelsEndpoints {
  readonly graph: string;
}

const defaultInstagramReelsEndpoints: InstagramReelsEndpoints = {
  graph: 'https://graph.facebook.com/v26.0',
};

function jobInput(value: JsonValue): InstagramReelsJobInput {
  const input = object(value);
  if (!input || typeof input.mediaId !== 'string' || typeof input.targetId !== 'string')
    throw new JobExecutionError(
      'INSTAGRAM_REELS_INPUT_INVALID',
      false,
      'The Instagram Reels publish job is invalid.',
    );
  const metadata = object(input.metadata);
  if (
    metadata !== undefined &&
    ((metadata.caption !== undefined && typeof metadata.caption !== 'string') ||
      (metadata.shareToFeed !== undefined && typeof metadata.shareToFeed !== 'boolean'))
  )
    throw new JobExecutionError(
      'INSTAGRAM_REELS_INPUT_INVALID',
      false,
      'The Instagram Reels publish options are invalid.',
    );
  return {
    mediaId: input.mediaId,
    targetId: input.targetId,
    ...(metadata === undefined
      ? {}
      : {
          metadata: {
            ...(typeof metadata.caption === 'string' ? { caption: metadata.caption } : {}),
            ...(typeof metadata.shareToFeed === 'boolean'
              ? { shareToFeed: metadata.shareToFeed }
              : {}),
          },
        }),
  };
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined;
}

function graphFailure(
  response: Response,
  value: Record<string, unknown> | undefined,
  phase: string,
) {
  const error = object(value?.error);
  const remoteCode = typeof error?.code === 'number' ? String(error.code) : 'REQUEST_FAILED';
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const permission =
    response.status === 401 ||
    response.status === 403 ||
    remoteCode === '10' ||
    remoteCode === '190';
  return new JobExecutionError(
    `INSTAGRAM_${phase}_${permission ? 'PERMISSION_DENIED' : remoteCode}`,
    retryable,
    permission
      ? 'Instagram rejected this target or its publishing permission. Reconnect the Meta account and verify the linked Page role.'
      : retryable
        ? 'Instagram is temporarily unavailable. The publish job will retry.'
        : 'Instagram rejected the Reels publish request.',
    retryAfterMs(response),
  );
}

async function responseBody(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return object(await response.json());
  } catch {
    return undefined;
  }
}

function isUploadUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'rupload.facebook.com';
  } catch {
    return false;
  }
}

/**
 * Instagram's local resumable flow has no documented byte-offset recovery query. Container IDs
 * are checkpointed before transfer; a transport interruption consequently stops safely instead of
 * creating another container or replaying unknown bytes.
 */
export class InstagramReelsJobHandler implements JobHandler {
  public readonly type = INSTAGRAM_REELS_JOB_TYPE;
  private readonly endpoints: InstagramReelsEndpoints;
  private readonly http: MetaHttpClient;
  private readonly now: () => Date;

  public constructor(
    private readonly media: MediaRepository,
    private readonly checkpoints: DestinationJobRepository,
    private readonly targets: MetaCredentialRepository,
    private readonly secrets: SecretStore,
    options: InstagramReelsJobHandlerOptions = {},
  ) {
    this.endpoints = { ...defaultInstagramReelsEndpoints, ...options.endpoints };
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public async execute(value: JsonValue, context: JobHandlerContext): Promise<void> {
    const input = jobInput(value);
    const asset = this.media.list().find((candidate) => candidate.id === input.mediaId);
    if (asset === undefined || asset.state !== 'available')
      throw new JobExecutionError(
        'INSTAGRAM_REELS_MEDIA_UNAVAILABLE',
        false,
        'The selected media file is unavailable.',
      );
    this.validateMedia(asset, input);
    const target = this.targets.listTargets().find((candidate) => candidate.id === input.targetId);
    if (
      target === undefined ||
      target.kind !== 'instagram_professional' ||
      !target.enabled ||
      target.availability !== 'available'
    )
      throw new JobExecutionError(
        'INSTAGRAM_TARGET_UNAVAILABLE',
        false,
        'This Instagram professional account is not enabled for publishing. Reconnect Meta and verify the linked Page content role.',
      );
    const credential = this.targets.findCredential(target.credentialId);
    if (credential?.status !== 'connected')
      throw new JobExecutionError(
        'INSTAGRAM_REAUTHORIZATION_REQUIRED',
        false,
        'Reconnect the Meta account to continue publishing to Instagram.',
      );
    const accessToken = await this.secrets.get(metaPageTokenReference(target.id));
    if (!accessToken)
      throw new JobExecutionError(
        'INSTAGRAM_PAGE_TOKEN_MISSING',
        false,
        'Reconnect the Meta account to restore the linked Page publishing token.',
      );

    let checkpoint =
      this.checkpoints.find(context.jobId) ??
      this.save({
        destinationId: 'instagram',
        jobId: context.jobId,
        remoteStatus: 'validating',
        uploadedBytes: 0,
      });
    if (checkpoint.remoteId === undefined)
      checkpoint = await this.createContainer(
        input,
        target.externalId,
        accessToken,
        checkpoint,
        context.jobId,
      );
    if (checkpoint.uploadedBytes < asset.sizeBytes) {
      if (context.attemptNumber > 1 && checkpoint.remoteStatus !== 'upload_retryable')
        throw new JobExecutionError(
          'INSTAGRAM_UPLOAD_RECOVERY_AMBIGUOUS',
          false,
          'Instagram does not provide a confirmed upload offset for this interrupted transfer. The container will not be replayed automatically.',
        );
      await this.upload(asset, accessToken, checkpoint, context);
      checkpoint = this.save({
        ...checkpoint,
        remoteStatus: 'remote_processing',
        uploadedBytes: asset.sizeBytes,
      });
      await this.secrets.delete(instagramUploadUriReference(context.jobId));
    }
    const status = await this.containerStatus(checkpoint, accessToken, context);
    if (status === 'IN_PROGRESS')
      throw new JobExecutionError(
        'INSTAGRAM_CONTAINER_PROCESSING',
        true,
        'Instagram is still processing the Reel container.',
        60_000,
      );
    if (status === 'ERROR' || status === 'EXPIRED') {
      this.save({ ...checkpoint, remoteStatus: 'failed' });
      throw new JobExecutionError(
        `INSTAGRAM_CONTAINER_${status}`,
        false,
        status === 'EXPIRED'
          ? 'The Instagram Reel container expired before it could be published.'
          : 'Instagram could not process this Reel. Check the video format and try again.',
      );
    }
    if (status === 'PUBLISHED') {
      this.save({ ...checkpoint, remoteStatus: 'published' });
      return;
    }
    if (status !== 'FINISHED')
      throw new JobExecutionError(
        'INSTAGRAM_CONTAINER_STATUS_INVALID',
        true,
        'Instagram returned an unknown Reel container status.',
      );
    if (checkpoint.remoteStatus === 'published' && checkpoint.remoteId !== undefined) return;
    checkpoint = this.save({ ...checkpoint, remoteStatus: 'publishing' });
    await this.publish(target.externalId, accessToken, checkpoint, context);
  }

  private validateMedia(asset: MediaAsset, input: InstagramReelsJobInput): void {
    const extension = asset.path.toLowerCase();
    if ((!extension.endsWith('.mp4') && !extension.endsWith('.mov')) || asset.sizeBytes <= 0)
      throw new JobExecutionError(
        'INSTAGRAM_REELS_MEDIA_INVALID',
        false,
        'Instagram Reels accepts a non-empty MP4 or MOV video.',
      );
    if (asset.sizeBytes > 300 * 1024 * 1024)
      throw new JobExecutionError(
        'INSTAGRAM_REELS_FILE_TOO_LARGE',
        false,
        'Instagram Reels accepts video files up to 300 MB.',
      );
    const duration = asset.metadata.durationSeconds;
    if (duration !== undefined && (duration < 3 || duration > 15 * 60))
      throw new JobExecutionError(
        'INSTAGRAM_REELS_DURATION_INVALID',
        false,
        'Instagram Reels must be between 3 seconds and 15 minutes long.',
      );
    if (
      asset.metadata.frameRate !== undefined &&
      (asset.metadata.frameRate < 23 || asset.metadata.frameRate > 60)
    )
      throw new JobExecutionError(
        'INSTAGRAM_REELS_FRAME_RATE_INVALID',
        false,
        'Instagram Reels requires a video frame rate from 23 to 60 FPS.',
      );
    if (asset.metadata.width !== undefined && asset.metadata.width > 1920)
      throw new JobExecutionError(
        'INSTAGRAM_REELS_WIDTH_INVALID',
        false,
        'Instagram Reels supports videos up to 1920 pixels wide.',
      );
    if (input.metadata?.caption !== undefined && input.metadata.caption.length > 2200)
      throw new JobExecutionError(
        'INSTAGRAM_REELS_CAPTION_TOO_LONG',
        false,
        'Instagram Reel captions are limited to 2,200 characters.',
      );
  }

  private async createContainer(
    input: InstagramReelsJobInput,
    instagramId: string,
    accessToken: string,
    checkpoint: DestinationJobRecord,
    jobId: string,
  ): Promise<DestinationJobRecord> {
    const form = new URLSearchParams({
      media_type: 'REELS',
      upload_type: 'resumable',
      access_token: accessToken,
    });
    if (input.metadata?.caption !== undefined) form.set('caption', input.metadata.caption);
    if (input.metadata?.shareToFeed !== undefined)
      form.set('share_to_feed', String(input.metadata.shareToFeed));
    let response: Response;
    try {
      response = await this.http(
        `${this.endpoints.graph}/${encodeURIComponent(instagramId)}/media`,
        {
          body: form,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
        },
      );
    } catch {
      throw new JobExecutionError(
        'INSTAGRAM_CONTAINER_NETWORK_ERROR',
        true,
        'Instagram could not be reached before creating a Reel container.',
      );
    }
    const result = await responseBody(response);
    if (!response.ok) throw graphFailure(response, result, 'CONTAINER');
    const containerId = typeof result?.id === 'string' ? result.id : undefined;
    const uploadUri = typeof result?.uri === 'string' ? result.uri : undefined;
    if (!containerId || !uploadUri || !isUploadUri(uploadUri))
      throw new JobExecutionError(
        'INSTAGRAM_CONTAINER_RESPONSE_INVALID',
        true,
        'Instagram returned an invalid resumable upload container.',
      );
    const saved = this.save({ ...checkpoint, remoteId: containerId, remoteStatus: 'uploading' });
    await this.secrets.set(instagramUploadUriReference(jobId), uploadUri);
    return saved;
  }

  private async upload(
    asset: MediaAsset,
    accessToken: string,
    checkpoint: DestinationJobRecord,
    context: JobHandlerContext,
  ): Promise<void> {
    const uploadUri = await this.secrets.get(instagramUploadUriReference(context.jobId));
    if (!uploadUri || !isUploadUri(uploadUri))
      throw new JobExecutionError(
        'INSTAGRAM_UPLOAD_URI_MISSING',
        false,
        'Instagram upload recovery needs the original upload URI. The container will not be duplicated automatically.',
      );
    let response: Response;
    try {
      response = await this.http(uploadUri, {
        body: createReadStream(asset.path),
        duplex: 'half',
        headers: {
          Authorization: `OAuth ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          file_size: String(asset.sizeBytes),
          offset: String(checkpoint.uploadedBytes),
        },
        method: 'POST',
        signal: context.signal,
      } as RequestInit);
    } catch {
      throw new JobExecutionError(
        'INSTAGRAM_UPLOAD_RECOVERY_AMBIGUOUS',
        false,
        'The Instagram upload connection ended without a confirmed result. The container will not be replayed automatically.',
      );
    }
    if (!response.ok) {
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      if (retryable) this.save({ ...checkpoint, remoteStatus: 'upload_retryable' });
      throw new JobExecutionError(
        response.status === 429 ? 'INSTAGRAM_UPLOAD_RATE_LIMITED' : 'INSTAGRAM_UPLOAD_FAILED',
        retryable,
        retryable
          ? 'Instagram temporarily rejected the upload. The transfer will retry before any bytes are accepted.'
          : 'Instagram rejected the Reel upload.',
        retryAfterMs(response),
      );
    }
  }

  private async containerStatus(
    checkpoint: DestinationJobRecord,
    accessToken: string,
    context: JobHandlerContext,
  ): Promise<string> {
    if (!checkpoint.remoteId)
      throw new JobExecutionError(
        'INSTAGRAM_CONTAINER_ID_MISSING',
        true,
        'Instagram container status is not available yet.',
      );
    const url = new URL(`${this.endpoints.graph}/${encodeURIComponent(checkpoint.remoteId)}`);
    url.searchParams.set('fields', 'status_code,status');
    url.searchParams.set('access_token', accessToken);
    let response: Response;
    try {
      response = await this.http(url, { signal: context.signal });
    } catch {
      throw new JobExecutionError(
        'INSTAGRAM_STATUS_NETWORK_ERROR',
        true,
        'Instagram container status could not be loaded.',
      );
    }
    const result = await responseBody(response);
    if (!response.ok) throw graphFailure(response, result, 'STATUS');
    return typeof result?.status_code === 'string' ? result.status_code : '';
  }

  private async publish(
    instagramId: string,
    accessToken: string,
    checkpoint: DestinationJobRecord,
    context: JobHandlerContext,
  ): Promise<void> {
    if (!checkpoint.remoteId)
      throw new JobExecutionError(
        'INSTAGRAM_CONTAINER_ID_MISSING',
        true,
        'Instagram Reel publishing is not available yet.',
      );
    const form = new URLSearchParams({
      access_token: accessToken,
      creation_id: checkpoint.remoteId,
    });
    let response: Response;
    try {
      response = await this.http(
        `${this.endpoints.graph}/${encodeURIComponent(instagramId)}/media_publish`,
        {
          body: form,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
          signal: context.signal,
        },
      );
    } catch {
      throw new JobExecutionError(
        'INSTAGRAM_PUBLISH_RECOVERY_AMBIGUOUS',
        false,
        'Instagram did not confirm whether the Reel was published. It will not be published again automatically.',
      );
    }
    const result = await responseBody(response);
    if (!response.ok) throw graphFailure(response, result, 'PUBLISH');
    if (typeof result?.id !== 'string')
      throw new JobExecutionError(
        'INSTAGRAM_PUBLISH_RESPONSE_INVALID',
        true,
        'Instagram returned an invalid publish response.',
      );
    let remoteUrl: string | undefined;
    try {
      const permalink = new URL(`${this.endpoints.graph}/${encodeURIComponent(result.id)}`);
      permalink.searchParams.set('fields', 'permalink');
      permalink.searchParams.set('access_token', accessToken);
      const permalinkResponse = await this.http(permalink, { signal: context.signal });
      const permalinkBody = await responseBody(permalinkResponse);
      if (permalinkResponse.ok && typeof permalinkBody?.permalink === 'string')
        remoteUrl = permalinkBody.permalink;
    } catch {
      // Publishing has already succeeded; a best-effort permalink lookup must not turn it into a retry.
    }
    this.save({
      ...checkpoint,
      remoteId: result.id,
      remoteStatus: 'published',
      uploadedBytes: checkpoint.uploadedBytes,
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
    });
  }

  private save(record: Omit<DestinationJobRecord, 'updatedAt'>): DestinationJobRecord {
    return this.checkpoints.save({ ...record, updatedAt: this.now() });
  }
}

export const FACEBOOK_REELS_JOB_TYPE = 'facebook.reels.publish';

export interface FacebookReelsJobInput {
  readonly mediaId: string;
  readonly targetId: string;
  readonly metadata?: { readonly description?: string; readonly title?: string };
}

export interface FacebookReelsJobHandlerOptions {
  readonly endpoints?: Partial<FacebookReelsEndpoints>;
  readonly http?: MetaHttpClient;
  readonly now?: () => Date;
}

export interface FacebookReelsEndpoints {
  readonly graph: string;
}

const defaultFacebookReelsEndpoints: FacebookReelsEndpoints = {
  graph: 'https://graph.facebook.com/v26.0',
};

function facebookJobInput(value: JsonValue): FacebookReelsJobInput {
  const input = object(value);
  if (!input || typeof input.mediaId !== 'string' || typeof input.targetId !== 'string')
    throw new JobExecutionError(
      'FACEBOOK_REELS_INPUT_INVALID',
      false,
      'The Facebook Reels publish job is invalid.',
    );
  const metadata = object(input.metadata);
  if (
    metadata !== undefined &&
    ((metadata.description !== undefined && typeof metadata.description !== 'string') ||
      (metadata.title !== undefined && typeof metadata.title !== 'string'))
  )
    throw new JobExecutionError(
      'FACEBOOK_REELS_INPUT_INVALID',
      false,
      'The Facebook Reels publish options are invalid.',
    );
  return {
    mediaId: input.mediaId,
    targetId: input.targetId,
    ...(metadata === undefined
      ? {}
      : {
          metadata: {
            ...(typeof metadata.description === 'string'
              ? { description: metadata.description }
              : {}),
            ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
          },
        }),
  };
}

function facebookGraphFailure(
  response: Response,
  value: Record<string, unknown> | undefined,
  phase: string,
): JobExecutionError {
  const error = object(value?.error);
  const remoteCode = typeof error?.code === 'number' ? String(error.code) : 'REQUEST_FAILED';
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const permission =
    response.status === 401 ||
    response.status === 403 ||
    remoteCode === '10' ||
    remoteCode === '190';
  return new JobExecutionError(
    `FACEBOOK_REELS_${phase}_${permission ? 'PERMISSION_DENIED' : remoteCode}`,
    retryable,
    permission
      ? 'Facebook rejected this Page or its publishing permission. Reconnect Meta and verify the Page content role.'
      : retryable
        ? 'Facebook is temporarily unavailable. The publish job will retry.'
        : 'Facebook rejected the Reels publish request.',
    retryAfterMs(response),
  );
}

function facebookUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'rupload.facebook.com';
  } catch {
    return false;
  }
}

function statusValue(value: Record<string, unknown> | undefined): string {
  const status = object(value?.status);
  const candidate = status?.video_status ?? value?.video_status ?? value?.status;
  return typeof candidate === 'string' ? candidate.toLowerCase() : '';
}

/** The documented Page Reels session supports byte-offset recovery via `bytes_transfered`. */
function transferredBytes(value: Record<string, unknown> | undefined): number | undefined {
  const status = object(value?.status);
  const candidate =
    status?.bytes_transfered ??
    value?.bytes_transfered ??
    // Accept the correctly spelled variant too: Meta has used both spellings in API material.
    status?.bytes_transferred ??
    value?.bytes_transferred;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
    ? Math.floor(candidate)
    : undefined;
}

/** Facebook Page Reels transport: stream locally, recover a confirmed server offset, then reconcile publication. */
export class FacebookReelsJobHandler implements JobHandler {
  public readonly type = FACEBOOK_REELS_JOB_TYPE;
  private readonly endpoints: FacebookReelsEndpoints;
  private readonly http: MetaHttpClient;
  private readonly now: () => Date;

  public constructor(
    private readonly media: MediaRepository,
    private readonly checkpoints: DestinationJobRepository,
    private readonly targets: MetaCredentialRepository,
    private readonly secrets: SecretStore,
    options: FacebookReelsJobHandlerOptions = {},
  ) {
    this.endpoints = { ...defaultFacebookReelsEndpoints, ...options.endpoints };
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public async execute(value: JsonValue, context: JobHandlerContext): Promise<void> {
    const input = facebookJobInput(value);
    const asset = this.media.list().find((candidate) => candidate.id === input.mediaId);
    if (asset === undefined || asset.state !== 'available')
      throw new JobExecutionError(
        'FACEBOOK_REELS_MEDIA_UNAVAILABLE',
        false,
        'The selected media file is unavailable.',
      );
    this.validateMedia(asset);
    const target = this.targets.listTargets().find((candidate) => candidate.id === input.targetId);
    if (
      target === undefined ||
      target.kind !== 'facebook_page' ||
      !target.enabled ||
      target.availability !== 'available'
    )
      throw new JobExecutionError(
        'FACEBOOK_PAGE_TARGET_UNAVAILABLE',
        false,
        'This Facebook Page is not enabled for publishing. Reconnect Meta and verify its CREATE_CONTENT task.',
      );
    if (this.targets.findCredential(target.credentialId)?.status !== 'connected')
      throw new JobExecutionError(
        'FACEBOOK_REAUTHORIZATION_REQUIRED',
        false,
        'Reconnect the Meta account to continue publishing to Facebook.',
      );
    const accessToken = await this.secrets.get(metaPageTokenReference(target.id));
    if (!accessToken)
      throw new JobExecutionError(
        'FACEBOOK_PAGE_TOKEN_MISSING',
        false,
        'Reconnect the Meta account to restore the Page publishing token.',
      );

    let checkpoint =
      this.checkpoints.find(context.jobId) ??
      this.save({
        destinationId: 'facebook',
        jobId: context.jobId,
        remoteStatus: 'validating',
        uploadedBytes: 0,
      });
    if (!checkpoint.remoteId)
      checkpoint = await this.start(
        input,
        target.externalId,
        accessToken,
        checkpoint,
        context.jobId,
      );
    if (checkpoint.remoteStatus === 'published') return;

    if (context.attemptNumber > 1 && checkpoint.uploadedBytes < asset.sizeBytes)
      checkpoint = await this.recoverOffset(checkpoint, accessToken, asset.sizeBytes, context);
    if (checkpoint.uploadedBytes < asset.sizeBytes) {
      await this.upload(asset, accessToken, checkpoint, context);
      checkpoint = this.save({
        ...checkpoint,
        remoteStatus: 'uploaded',
        uploadedBytes: asset.sizeBytes,
      });
    }
    if (!['verifying', 'processing', 'publishing'].includes(checkpoint.remoteStatus)) {
      checkpoint = this.save({ ...checkpoint, remoteStatus: 'publishing' });
      await this.finish(input, target.externalId, accessToken, checkpoint, context);
      checkpoint = this.save({ ...checkpoint, remoteStatus: 'verifying' });
    }
    await this.reconcile(checkpoint, accessToken, context);
  }

  private validateMedia(asset: MediaAsset): void {
    if (!asset.path.toLowerCase().endsWith('.mp4') || asset.sizeBytes <= 0)
      throw new JobExecutionError(
        'FACEBOOK_REELS_MEDIA_INVALID',
        false,
        'Facebook Reels requires a non-empty MP4 video.',
      );
    const duration = asset.metadata.durationSeconds;
    if (duration !== undefined && (duration < 3 || duration > 90))
      throw new JobExecutionError(
        'FACEBOOK_REELS_DURATION_INVALID',
        false,
        'Facebook Reels must be between 3 and 90 seconds long.',
      );
    const frameRate = asset.metadata.frameRate;
    if (frameRate !== undefined && (frameRate < 24 || frameRate > 60))
      throw new JobExecutionError(
        'FACEBOOK_REELS_FRAME_RATE_INVALID',
        false,
        'Facebook Reels requires a frame rate from 24 to 60 FPS.',
      );
    const { height, width } = asset.metadata;
    if ((width !== undefined && width < 540) || (height !== undefined && height < 960))
      throw new JobExecutionError(
        'FACEBOOK_REELS_DIMENSIONS_INVALID',
        false,
        'Facebook Reels requires video at least 540 by 960 pixels.',
      );
    if (width !== undefined && height !== undefined && Math.abs(width / height - 9 / 16) > 0.01)
      throw new JobExecutionError(
        'FACEBOOK_REELS_ASPECT_RATIO_INVALID',
        false,
        'Facebook Reels requires a 9:16 video.',
      );
  }

  private async start(
    input: FacebookReelsJobInput,
    pageId: string,
    accessToken: string,
    checkpoint: DestinationJobRecord,
    jobId: string,
  ): Promise<DestinationJobRecord> {
    const form = new URLSearchParams({ access_token: accessToken, upload_phase: 'start' });
    if (input.metadata?.description !== undefined)
      form.set('description', input.metadata.description);
    if (input.metadata?.title !== undefined) form.set('title', input.metadata.title);
    let response: Response;
    try {
      response = await this.http(
        `${this.endpoints.graph}/${encodeURIComponent(pageId)}/video_reels`,
        {
          body: form,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
        },
      );
    } catch {
      throw new JobExecutionError(
        'FACEBOOK_REELS_START_NETWORK_ERROR',
        true,
        'Facebook could not be reached before starting the Reel upload.',
      );
    }
    const result = await responseBody(response);
    if (!response.ok) throw facebookGraphFailure(response, result, 'START');
    const videoId = typeof result?.video_id === 'string' ? result.video_id : undefined;
    const uploadUrl = typeof result?.upload_url === 'string' ? result.upload_url : undefined;
    if (!videoId || !uploadUrl || !facebookUploadUrl(uploadUrl))
      throw new JobExecutionError(
        'FACEBOOK_REELS_START_RESPONSE_INVALID',
        true,
        'Facebook returned an invalid Reel upload session.',
      );
    const saved = this.save({ ...checkpoint, remoteId: videoId, remoteStatus: 'uploading' });
    await this.secrets.set(facebookReelsUploadUriReference(jobId), uploadUrl);
    return saved;
  }

  private async recoverOffset(
    checkpoint: DestinationJobRecord,
    accessToken: string,
    sizeBytes: number,
    context: JobHandlerContext,
  ): Promise<DestinationJobRecord> {
    const result = await this.status(checkpoint, accessToken, context);
    const transferred = transferredBytes(result);
    if (transferred === undefined)
      throw new JobExecutionError(
        'FACEBOOK_REELS_UPLOAD_OFFSET_MISSING',
        true,
        'Facebook did not confirm the uploaded byte offset yet.',
      );
    return this.save({
      ...checkpoint,
      remoteStatus: 'uploading',
      uploadedBytes: Math.min(transferred, sizeBytes),
    });
  }

  private async upload(
    asset: MediaAsset,
    accessToken: string,
    checkpoint: DestinationJobRecord,
    context: JobHandlerContext,
  ): Promise<void> {
    const uploadUrl = await this.secrets.get(facebookReelsUploadUriReference(context.jobId));
    if (!uploadUrl || !facebookUploadUrl(uploadUrl))
      throw new JobExecutionError(
        'FACEBOOK_REELS_UPLOAD_URL_MISSING',
        false,
        'Reconnect Facebook and start a new publish job; the upload session is unavailable.',
      );
    let response: Response;
    try {
      response = await this.http(uploadUrl, {
        body: createReadStream(asset.path, { start: checkpoint.uploadedBytes }),
        duplex: 'half',
        headers: {
          Authorization: `OAuth ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          file_size: String(asset.sizeBytes),
          offset: String(checkpoint.uploadedBytes),
        },
        method: 'POST',
        signal: context.signal,
      } as RequestInit);
    } catch {
      throw new JobExecutionError(
        'FACEBOOK_REELS_UPLOAD_NETWORK_ERROR',
        true,
        'Facebook upload was interrupted and will resume from the confirmed server offset.',
      );
    }
    const result = await responseBody(response);
    if (!response.ok) throw facebookGraphFailure(response, result, 'UPLOAD');
  }

  private async finish(
    input: FacebookReelsJobInput,
    pageId: string,
    accessToken: string,
    checkpoint: DestinationJobRecord,
    context: JobHandlerContext,
  ): Promise<void> {
    if (!checkpoint.remoteId)
      throw new JobExecutionError(
        'FACEBOOK_REELS_VIDEO_ID_MISSING',
        true,
        'Facebook Reel finalization is not available yet.',
      );
    const form = new URLSearchParams({
      access_token: accessToken,
      upload_phase: 'finish',
      video_id: checkpoint.remoteId,
      video_state: 'PUBLISHED',
    });
    if (input.metadata?.description !== undefined)
      form.set('description', input.metadata.description);
    if (input.metadata?.title !== undefined) form.set('title', input.metadata.title);
    let response: Response;
    try {
      response = await this.http(
        `${this.endpoints.graph}/${encodeURIComponent(pageId)}/video_reels`,
        {
          body: form,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
          signal: context.signal,
        },
      );
    } catch {
      throw new JobExecutionError(
        'FACEBOOK_REELS_FINISH_RECOVERY_AMBIGUOUS',
        false,
        'Facebook did not confirm whether the Reel was finalized. It will not be finalized again automatically.',
      );
    }
    const result = await responseBody(response);
    if (!response.ok) throw facebookGraphFailure(response, result, 'FINISH');
  }

  private async reconcile(
    checkpoint: DestinationJobRecord,
    accessToken: string,
    context: JobHandlerContext,
  ): Promise<void> {
    const result = await this.status(checkpoint, accessToken, context);
    const state = statusValue(result);
    if (state === 'published') {
      const remoteUrl =
        typeof result?.permalink_url === 'string' ? result.permalink_url : undefined;
      this.save({
        ...checkpoint,
        remoteStatus: 'published',
        ...(remoteUrl === undefined ? {} : { remoteUrl }),
      });
      await this.secrets.delete(facebookReelsUploadUriReference(context.jobId));
      return;
    }
    if (['uploading', 'processing', 'publishing', 'ready'].includes(state)) {
      this.save({ ...checkpoint, remoteStatus: state });
      throw new JobExecutionError(
        'FACEBOOK_REELS_PROCESSING',
        true,
        'Facebook is still processing the Reel.',
        60_000,
      );
    }
    if (['error', 'failed'].includes(state)) {
      this.save({ ...checkpoint, remoteStatus: 'failed' });
      throw new JobExecutionError(
        'FACEBOOK_REELS_PROCESSING_FAILED',
        false,
        'Facebook could not process this Reel. Check the video format and try again.',
      );
    }
    throw new JobExecutionError(
      'FACEBOOK_REELS_STATUS_INVALID',
      true,
      'Facebook returned an unknown Reel status.',
    );
  }

  private async status(
    checkpoint: DestinationJobRecord,
    accessToken: string,
    context: JobHandlerContext,
  ): Promise<Record<string, unknown> | undefined> {
    if (!checkpoint.remoteId)
      throw new JobExecutionError(
        'FACEBOOK_REELS_VIDEO_ID_MISSING',
        true,
        'Facebook Reel status is not available yet.',
      );
    const url = new URL(`${this.endpoints.graph}/${encodeURIComponent(checkpoint.remoteId)}`);
    url.searchParams.set('fields', 'status,permalink_url');
    url.searchParams.set('access_token', accessToken);
    let response: Response;
    try {
      response = await this.http(url, { signal: context.signal });
    } catch {
      throw new JobExecutionError(
        'FACEBOOK_REELS_STATUS_NETWORK_ERROR',
        true,
        'Facebook Reel status could not be loaded.',
      );
    }
    const result = await responseBody(response);
    if (!response.ok) throw facebookGraphFailure(response, result, 'STATUS');
    return result;
  }

  private save(record: Omit<DestinationJobRecord, 'updatedAt'>): DestinationJobRecord {
    return this.checkpoints.save({ ...record, updatedAt: this.now() });
  }
}
