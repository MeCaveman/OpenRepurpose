import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  AccountCapability,
  AccountRepository,
  ConnectedAccount,
  MediaResolver,
  MediaResolverContext,
  MediaResolverRequest,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
} from '@openrepurpose/core';
import { MediaResolutionError } from '@openrepurpose/core';
import type {
  SourceAdapter,
  SourceAdapterContext,
  SourceCapabilities,
  SourceItemObservation,
  SourceJsonValue,
  SourcePollRequest,
  SourcePollResult,
  PluginManifest,
  SecretReference,
  SecretStore,
} from '@openrepurpose/platform-sdk';
import { parseRetryAfterMs, PlatformError } from '@openrepurpose/platform-sdk';

export interface TwitchAccessToken {
  readonly accessToken: string;
  readonly clientId: string;
}

/** Credential boundary implemented by the account connector; tokens never enter source config. */
export interface TwitchAccessTokenProvider {
  getAccessToken(accountId: string): Promise<TwitchAccessToken>;
}

export interface TwitchSourceConfiguration {
  readonly accountId: string;
  readonly broadcasterId: string;
  /** An editor/broadcaster ID is required only to acquire official clip bytes. */
  readonly editorId?: string;
  readonly kind: 'clips' | 'vods';
}

export interface TwitchSourceAdapterOptions {
  readonly apiBaseUrl?: string;
  readonly http?: typeof fetch;
  readonly now?: () => Date;
}

interface Cursor {
  readonly after?: string;
  readonly version: 1;
  readonly windowStartedAt?: string;
}
const apiBase = 'https://api.twitch.tv/helix';

const twitchClientId: SecretReference = {
  name: 'client-id',
  ownerId: 'twitch',
  scope: 'application',
};
const twitchClientSecret: SecretReference = {
  name: 'client-secret',
  ownerId: 'twitch',
  scope: 'application',
};
export function twitchRefreshTokenReference(accountId: string): SecretReference {
  return { name: 'twitch-refresh-token', ownerId: accountId, scope: 'account' };
}
export interface TwitchOAuthEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly validate: string;
}
export interface TwitchOAuthServiceOptions {
  readonly endpoints?: Partial<TwitchOAuthEndpoints>;
  readonly http?: typeof fetch;
  readonly now?: () => Date;
  readonly flowLifetimeMs?: number;
}
export interface TwitchCredentialStatus {
  readonly configured: boolean;
  readonly redirectUri: string;
}
export interface TwitchOAuthCallbackInput {
  readonly browserBinding?: string;
  readonly code?: string;
  readonly error?: string;
  readonly state?: string;
}
const twitchEndpoints: TwitchOAuthEndpoints = {
  authorization: 'https://id.twitch.tv/oauth2/authorize',
  token: 'https://id.twitch.tv/oauth2/token',
  validate: 'https://id.twitch.tv/oauth2/validate',
};

/** Server-side Twitch authorization-code connector; browser-safe account data excludes all secrets. */
export class TwitchOAuthService implements TwitchAccessTokenProvider {
  private readonly endpoints: TwitchOAuthEndpoints;
  private readonly http: typeof fetch;
  private readonly now: () => Date;
  private readonly flowLifetimeMs: number;
  public constructor(
    private readonly accounts: AccountRepository,
    private readonly requests: OAuthAuthorizationRequestRepository,
    private readonly secrets: SecretStore,
    private readonly appUrl: URL,
    options: TwitchOAuthServiceOptions = {},
  ) {
    this.endpoints = { ...twitchEndpoints, ...options.endpoints };
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.flowLifetimeMs = options.flowLifetimeMs ?? 10 * 60_000;
  }
  public async configureCredentials(input: {
    readonly clientId: string;
    readonly clientSecret: string;
  }): Promise<void> {
    if (!input.clientId.trim() || !input.clientSecret.trim())
      throw twitchFailure(
        'configuration',
        'TWITCH_CREDENTIALS_REQUIRED',
        'A Twitch client ID and client secret are required.',
      );
    const previous = await this.secrets.get(twitchClientId);
    await this.secrets.set(twitchClientId, input.clientId.trim());
    await this.secrets.set(twitchClientSecret, input.clientSecret.trim());
    if (previous !== undefined && previous !== input.clientId.trim())
      this.accounts.setProviderStatus('twitch', 'reauthorization_required', this.now());
  }
  public async credentialStatus(): Promise<TwitchCredentialStatus> {
    return {
      configured:
        (await this.secrets.get(twitchClientId)) !== undefined &&
        (await this.secrets.get(twitchClientSecret)) !== undefined,
      redirectUri: this.redirectUri(),
    };
  }
  public listAccounts(): readonly ConnectedAccount[] {
    return this.accounts.list();
  }
  public async removeAccount(id: string): Promise<ConnectedAccount | undefined> {
    const account = this.accounts.findById(id);
    if (account?.provider !== 'twitch') return undefined;
    await this.secrets.delete(twitchRefreshTokenReference(id));
    return this.accounts.remove(id);
  }
  public async beginAuthorization(
    browserBinding: string,
    input: { readonly officialClipDownload?: boolean } = {},
  ): Promise<{ readonly authorizationUrl: string; readonly expiresAt: Date }> {
    if (!browserBinding)
      throw twitchFailure(
        'authentication',
        'TWITCH_OAUTH_SESSION_REQUIRED',
        'A local browser session is required to connect Twitch.',
      );
    const credentials = await this.credentials();
    const now = this.now();
    this.requests.deleteExpired(now);
    const state = randomBytes(32).toString('base64url');
    const request: OAuthAuthorizationRequest = {
      id: randomUUID(),
      provider: 'twitch',
      stateHash: hash(state),
      bindingHash: hash(browserBinding),
      redirectUri: this.redirectUri(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.flowLifetimeMs),
    };
    this.requests.create(request);
    const url = new URL(this.endpoints.authorization);
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (input.officialClipDownload === true)
      url.searchParams.set('scope', 'channel:manage:clips editor:manage:clips');
    return { authorizationUrl: url.toString(), expiresAt: request.expiresAt };
  }
  public async completeAuthorization(input: TwitchOAuthCallbackInput): Promise<ConnectedAccount> {
    if (!input.state || !input.browserBinding)
      throw twitchFailure(
        'authentication',
        'TWITCH_OAUTH_STATE_INVALID',
        'The Twitch authorization response has invalid state.',
      );
    const request = this.requests.consumeByStateHash(hash(input.state), hash(input.browserBinding));
    if (request === undefined || request.expiresAt <= this.now())
      throw twitchFailure(
        'authentication',
        'TWITCH_OAUTH_STATE_INVALID',
        'The Twitch authorization response has invalid or expired state.',
      );
    if (input.error !== undefined)
      throw twitchFailure(
        'authorization',
        'TWITCH_OAUTH_DENIED',
        'Twitch authorization was not granted.',
      );
    if (!input.code)
      throw twitchFailure(
        'authentication',
        'TWITCH_OAUTH_CODE_MISSING',
        'The Twitch authorization response did not include a code.',
      );
    const credentials = await this.credentials();
    const token = await this.token(
      new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: request.redirectUri,
      }),
    );
    if (!token.refreshToken)
      throw twitchFailure(
        'authentication',
        'TWITCH_REFRESH_TOKEN_MISSING',
        'Twitch did not return a refresh token. Connect the account again.',
      );
    const identity = await this.validate(token.accessToken);
    const now = this.now();
    const account = this.accounts.upsert({
      id: randomUUID(),
      provider: 'twitch',
      externalId: identity.userId,
      displayName: identity.login,
      status: 'connected',
      capabilities: twitchCapabilities(identity.scopes),
      connectedAt: now,
      updatedAt: now,
    });
    await this.secrets.set(twitchRefreshTokenReference(account.id), token.refreshToken);
    return account;
  }
  public async getAccessToken(accountId: string): Promise<TwitchAccessToken> {
    const account = this.accounts.findById(accountId);
    if (account?.provider !== 'twitch' || account.status !== 'connected')
      throw twitchFailure(
        'authentication',
        'TWITCH_ACCOUNT_REAUTHORIZATION_REQUIRED',
        'Reconnect the Twitch account to continue.',
      );
    const refreshToken = await this.secrets.get(twitchRefreshTokenReference(accountId));
    if (!refreshToken)
      throw twitchFailure(
        'authentication',
        'TWITCH_REFRESH_TOKEN_MISSING',
        'Reconnect the Twitch account to continue.',
      );
    const credentials = await this.credentials();
    try {
      const token = await this.token(
        new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      );
      if (token.refreshToken)
        await this.secrets.set(twitchRefreshTokenReference(accountId), token.refreshToken);
      const identity = await this.validate(token.accessToken);
      this.accounts.upsert({
        ...account,
        capabilities: twitchCapabilities(identity.scopes),
        updatedAt: this.now(),
      });
      return { accessToken: token.accessToken, clientId: credentials.clientId };
    } catch (error) {
      if (
        error instanceof PlatformError &&
        (error.category === 'authentication' || error.category === 'authorization')
      )
        this.accounts.setStatus(accountId, 'reauthorization_required', this.now());
      throw error;
    }
  }
  private async credentials(): Promise<{
    readonly clientId: string;
    readonly clientSecret: string;
  }> {
    const [clientId, clientSecret] = await Promise.all([
      this.secrets.get(twitchClientId),
      this.secrets.get(twitchClientSecret),
    ]);
    if (!clientId || !clientSecret)
      throw twitchFailure(
        'configuration',
        'TWITCH_CREDENTIALS_NOT_CONFIGURED',
        'Configure Twitch OAuth credentials before connecting.',
      );
    return { clientId, clientSecret };
  }
  private redirectUri(): string {
    return new URL('/api/accounts/twitch/oauth/callback', this.appUrl).toString();
  }
  private async token(
    form: URLSearchParams,
  ): Promise<{ readonly accessToken: string; readonly refreshToken?: string }> {
    let response: Response;
    try {
      response = await this.http(this.endpoints.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
    } catch (cause) {
      throw new PlatformError({
        category: 'network',
        code: 'TWITCH_TOKEN_NETWORK_ERROR',
        cause,
        publicMessage: 'Twitch OAuth could not be reached.',
        retryable: true,
      });
    }
    const body = await responseObject(response);
    if (!response.ok)
      throw twitchFailure(
        response.status === 401 ? 'authentication' : 'remote',
        'TWITCH_TOKEN_FAILED',
        'Twitch could not refresh the account authorization.',
        response.status >= 500,
      );
    if (typeof body?.access_token !== 'string')
      throw twitchFailure(
        'remote',
        'TWITCH_TOKEN_RESPONSE_INVALID',
        'Twitch returned an invalid token response.',
      );
    return {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    };
  }
  private async validate(accessToken: string): Promise<{
    readonly login: string;
    readonly scopes: readonly string[];
    readonly userId: string;
  }> {
    let response: Response;
    try {
      response = await this.http(this.endpoints.validate, {
        headers: { Authorization: `OAuth ${accessToken}` },
      });
    } catch (cause) {
      throw new PlatformError({
        category: 'network',
        code: 'TWITCH_TOKEN_VALIDATE_NETWORK_ERROR',
        cause,
        publicMessage: 'Twitch token validation could not be completed.',
        retryable: true,
      });
    }
    const body = await responseObject(response);
    if (!response.ok || typeof body?.user_id !== 'string' || typeof body.login !== 'string')
      throw twitchFailure(
        'authentication',
        'TWITCH_TOKEN_INVALID',
        'Reconnect the Twitch account to continue.',
      );
    return {
      userId: body.user_id,
      login: body.login,
      scopes: Array.isArray(body.scopes)
        ? body.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
    };
  }
}
function twitchCapabilities(scopes: readonly string[]): readonly AccountCapability[] {
  return [
    'twitch.identity.read',
    ...(scopes.includes('channel:manage:clips') || scopes.includes('editor:manage:clips')
      ? ['twitch.clip.download' as const]
      : []),
  ];
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function twitchFailure(
  category: PlatformError['category'],
  code: string,
  publicMessage: string,
  retryable = false,
): PlatformError {
  return new PlatformError({ category, code, publicMessage, retryable });
}
async function responseObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return object(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Helix polling is authoritative: EventSub has no clip-created or VOD-published event. Clip
 * queries intentionally use a bounded overlapping time window because their result order is by
 * view count, not creation time. Persisted external IDs provide the correctness dedupe layer.
 */
export class TwitchSourceAdapter implements SourceAdapter {
  public readonly displayName = 'Twitch';
  public readonly id = 'twitch';
  private readonly apiBaseUrl: string;
  private readonly http: typeof fetch;
  private readonly now: () => Date;

  public constructor(
    private readonly tokens: TwitchAccessTokenProvider,
    options: TwitchSourceAdapterOptions = {},
  ) {
    this.apiBaseUrl = options.apiBaseUrl ?? apiBase;
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  public async capabilities(): Promise<SourceCapabilities> {
    return {
      eventIds: false,
      mediaResolution: ['local_original', 'official_download'],
      polling: true,
    };
  }
  public async poll(
    request: SourcePollRequest,
    context: SourceAdapterContext,
  ): Promise<SourcePollResult> {
    const config = parseConfig(request.configuration);
    if (request.connectionExternalId !== config.broadcasterId)
      throw failure(
        'configuration',
        'TWITCH_SOURCE_BROADCASTER_MISMATCH',
        'The configured Twitch broadcaster is invalid.',
      );
    const cursor = parseCursor(request.cursor);
    const credential = await this.tokens.getAccessToken(config.accountId);
    const url = new URL(config.kind === 'clips' ? 'clips' : 'videos', `${this.apiBaseUrl}/`);
    if (config.kind === 'clips') {
      const started =
        cursor.windowStartedAt ?? new Date(this.now().getTime() - 6 * 60 * 60_000).toISOString();
      url.searchParams.set('broadcaster_id', config.broadcasterId);
      url.searchParams.set('started_at', started);
      url.searchParams.set('ended_at', this.now().toISOString());
      url.searchParams.set('first', '100');
    } else {
      url.searchParams.set('user_id', config.broadcasterId);
      url.searchParams.set('type', 'archive');
      url.searchParams.set('sort', 'time');
      url.searchParams.set('first', '100');
      if (cursor.after !== undefined) url.searchParams.set('after', cursor.after);
    }
    const body = await helix(
      this.http,
      url,
      credential,
      context.signal,
      'TWITCH_SOURCE_POLL_FAILED',
    );
    const data = Array.isArray(body.data) ? body.data : [];
    const items = data
      .map((value) => (config.kind === 'clips' ? clip(value, config) : vod(value)))
      .filter((value): value is SourceItemObservation => value !== undefined);
    const after = object(body.pagination)?.cursor;
    const next = typeof after === 'string' && after.length > 0 ? after : undefined;
    return {
      hasMore: config.kind === 'vods' && next !== undefined,
      items,
      cursor: JSON.stringify({
        version: 1,
        ...(config.kind === 'clips'
          ? { windowStartedAt: new Date(this.now().getTime() - 6 * 60 * 60_000).toISOString() }
          : {}),
        ...(next === undefined ? {} : { after: next }),
      }),
    };
  }
}

/** Resolves a fresh temporary official URL at execution time; no Twitch URL is persisted in metadata. */
export class TwitchClipMediaResolver implements MediaResolver {
  public readonly id = 'twitch-official-clip-download';
  private readonly apiBaseUrl: string;
  private readonly http: typeof fetch;
  public constructor(
    private readonly tokens: TwitchAccessTokenProvider,
    options: Pick<TwitchSourceAdapterOptions, 'apiBaseUrl' | 'http'> = {},
  ) {
    this.apiBaseUrl = options.apiBaseUrl ?? apiBase;
    this.http = options.http ?? fetch;
  }
  public canResolve(request: MediaResolverRequest): boolean {
    return (
      request.strategy === 'official_download' &&
      request.sourceItem.metadata.twitchKind === 'clip' &&
      typeof request.sourceItem.metadata.accountId === 'string' &&
      typeof request.sourceItem.metadata.broadcasterId === 'string' &&
      typeof request.sourceItem.metadata.editorId === 'string'
    );
  }
  public async resolve(
    request: MediaResolverRequest,
    context: MediaResolverContext,
  ): Promise<void> {
    if (!this.canResolve(request))
      throw new MediaResolutionError(
        'TWITCH_CLIP_DOWNLOAD_UNAVAILABLE',
        false,
        'Official Twitch clip download is not available for this source item.',
      );
    const metadata = request.sourceItem.metadata;
    const credential = await this.tokens.getAccessToken(metadata.accountId as string);
    const url = new URL('clips/downloads', `${this.apiBaseUrl}/`);
    url.searchParams.set('broadcaster_id', metadata.broadcasterId as string);
    url.searchParams.set('editor_id', metadata.editorId as string);
    url.searchParams.append('clip_id', request.sourceItem.externalId);
    const body = await helix(
      this.http,
      url,
      credential,
      context.signal,
      'TWITCH_CLIP_DOWNLOAD_LOOKUP_FAILED',
    );
    const result = Array.isArray(body.data) ? object(body.data[0]) : undefined;
    const downloadUrl =
      typeof result?.landscape_download_url === 'string'
        ? result.landscape_download_url
        : typeof result?.portrait_download_url === 'string'
          ? result.portrait_download_url
          : undefined;
    if (downloadUrl === undefined)
      throw new MediaResolutionError(
        'TWITCH_CLIP_MEDIA_UNAVAILABLE',
        false,
        'Twitch has no downloadable rendition for this clip.',
      );
    let response: Response;
    try {
      response = await this.http(downloadUrl, { signal: context.signal });
    } catch {
      throw new MediaResolutionError(
        context.signal.aborted ? 'TWITCH_CLIP_DOWNLOAD_CANCELLED' : 'TWITCH_CLIP_DOWNLOAD_FAILED',
        !context.signal.aborted,
        context.signal.aborted
          ? 'Twitch clip download was cancelled.'
          : 'Twitch clip download could not be started.',
      );
    }
    if (!response.ok || response.body === null)
      throw new MediaResolutionError(
        response.status === 401 || response.status === 403
          ? 'TWITCH_CLIP_DOWNLOAD_URL_EXPIRED'
          : 'TWITCH_CLIP_DOWNLOAD_FAILED',
        response.status === 401 ||
          response.status === 403 ||
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        response.status === 401 || response.status === 403
          ? 'The temporary Twitch clip download URL expired; a fresh URL will be requested on retry.'
          : 'Twitch clip download failed; a fresh URL will be requested on retry.',
      );
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(context.destinationPath),
        { signal: context.signal },
      );
    } catch {
      throw new MediaResolutionError(
        context.signal.aborted ? 'TWITCH_CLIP_DOWNLOAD_CANCELLED' : 'TWITCH_CLIP_DOWNLOAD_FAILED',
        !context.signal.aborted,
        context.signal.aborted
          ? 'Twitch clip download was cancelled.'
          : 'Twitch clip download failed; a fresh URL will be requested on retry.',
      );
    }
  }
}

export const twitchPluginManifest = {
  capabilities: [{ id: 'twitch', kind: 'source' }],
  configurationSchema: { additionalProperties: false, properties: {}, type: 'object' },
  id: 'openrepurpose.twitch',
  name: 'OpenRepurpose Twitch',
  requiredApiVersion: '^1.0.0',
  permissions: {
    childProcesses: [],
    filesystem: [{ access: ['write'], root: 'temp' }],
    networkHosts: ['api.twitch.tv', 'id.twitch.tv'],
    secrets: [
      { access: ['read', 'write'], name: 'client-id', scope: 'application' },
      { access: ['read', 'write', 'delete'], name: 'client-secret', scope: 'application' },
      { access: ['read', 'write', 'delete'], name: 'twitch-refresh-token', scope: 'account' },
    ],
  },
  version: '1.0.0',
} as const satisfies PluginManifest;

function parseConfig(value: Readonly<Record<string, SourceJsonValue>>): TwitchSourceConfiguration {
  const accountId = value.accountId,
    broadcasterId = value.broadcasterId,
    kind = value.kind,
    editorId = value.editorId;
  if (
    typeof accountId !== 'string' ||
    !accountId.trim() ||
    typeof broadcasterId !== 'string' ||
    !broadcasterId.trim() ||
    (kind !== 'clips' && kind !== 'vods') ||
    (editorId !== undefined && typeof editorId !== 'string')
  )
    throw failure(
      'configuration',
      'TWITCH_SOURCE_CONFIGURATION_INVALID',
      'A Twitch account, broadcaster, and source type are required.',
    );
  return {
    accountId,
    broadcasterId,
    kind,
    ...(typeof editorId === 'string' && editorId.trim() ? { editorId } : {}),
  };
}
function parseCursor(raw: string | null): Cursor {
  if (raw === null) return { version: 1 };
  try {
    const value = JSON.parse(raw) as Cursor;
    if (
      value.version !== 1 ||
      (value.after !== undefined && !value.after) ||
      (value.windowStartedAt !== undefined && !Number.isFinite(Date.parse(value.windowStartedAt)))
    )
      throw new Error();
    return value;
  } catch {
    throw failure(
      'configuration',
      'TWITCH_SOURCE_CURSOR_INVALID',
      'The stored Twitch source cursor is invalid.',
    );
  }
}
function clip(
  value: unknown,
  config: TwitchSourceConfiguration,
): SourceItemObservation | undefined {
  const item = object(value);
  if (
    typeof item?.id !== 'string' ||
    typeof item.created_at !== 'string' ||
    !Number.isFinite(Date.parse(item.created_at))
  )
    return undefined;
  return {
    externalId: item.id,
    publishedAt: new Date(item.created_at).toISOString(),
    metadata: {
      accountId: config.accountId,
      broadcasterId: config.broadcasterId,
      ...(config.editorId === undefined ? {} : { editorId: config.editorId }),
      twitchKind: 'clip',
      title: string(item.title),
      url: string(item.url),
      videoId: string(item.video_id),
      durationSeconds: number(item.duration),
    },
    media: {
      availability: config.editorId === undefined ? 'unavailable' : 'available',
      resolutionStrategies:
        config.editorId === undefined
          ? ['local_original']
          : ['local_original', 'official_download'],
      rightsRequirement: 'connection_authorization',
    },
  };
}
function vod(value: unknown): SourceItemObservation | undefined {
  const item = object(value);
  if (
    typeof item?.id !== 'string' ||
    typeof item.published_at !== 'string' ||
    !Number.isFinite(Date.parse(item.published_at))
  )
    return undefined;
  return {
    externalId: item.id,
    publishedAt: new Date(item.published_at).toISOString(),
    metadata: {
      twitchKind: 'vod',
      title: string(item.title),
      url: string(item.url),
      duration: string(item.duration),
      videoType: string(item.type),
    },
    media: {
      availability: 'unavailable',
      resolutionStrategies: ['local_original'],
      rightsRequirement: 'connection_authorization',
    },
  };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function failure(
  category: PlatformError['category'],
  code: string,
  publicMessage: string,
): PlatformError {
  return new PlatformError({ category, code, publicMessage, retryable: false });
}
async function helix(
  http: typeof fetch,
  url: URL,
  credential: TwitchAccessToken,
  signal: AbortSignal,
  code: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await http(url, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Client-Id': credential.clientId,
      },
      signal,
    });
  } catch (error) {
    throw new PlatformError({
      category: 'network',
      code: `${code}_NETWORK_ERROR`,
      cause: error,
      publicMessage: 'Twitch could not be reached.',
      retryable: true,
    });
  }
  if (!response.ok) {
    const reset = response.headers.get('Ratelimit-Reset');
    const retryAfterMs =
      parseRetryAfterMs(response.headers.get('Retry-After')) ??
      (reset !== null && /^\d+$/.test(reset)
        ? Math.max(0, Number(reset) * 1000 - Date.now())
        : undefined);
    throw new PlatformError({
      category:
        response.status === 401
          ? 'authentication'
          : response.status === 403
            ? 'authorization'
            : response.status === 429
              ? 'rate_limit'
              : 'remote',
      code,
      publicMessage:
        response.status === 401
          ? 'Reconnect the Twitch account to continue.'
          : response.status === 403
            ? 'Twitch denied this action for the selected broadcaster.'
            : 'Twitch could not complete the request.',
      retryable: response.status === 429 || response.status >= 500,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return (await responseObject(response)) ?? {};
}
