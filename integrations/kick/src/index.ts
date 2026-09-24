import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AccountCapability,
  AccountRepository,
  ConnectedAccount,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
} from '@openrepurpose/core';
import type {
  SecretReference,
  SecretStore,
  PluginManifest,
  SourceAdapter,
  SourceAdapterContext,
  SourceCapabilities,
  SourceItemObservation,
  SourceJsonValue,
  SourcePollRequest,
  SourcePollResult,
} from '@openrepurpose/platform-sdk';
import { parseRetryAfterMs, PlatformError } from '@openrepurpose/platform-sdk';

export interface KickAccessToken {
  readonly accessToken: string;
}
export interface KickAccessTokenProvider {
  getAccessToken(accountId: string): Promise<KickAccessToken>;
}
export interface KickOAuthEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly user: string;
}
export interface KickOAuthServiceOptions {
  readonly endpoints?: Partial<KickOAuthEndpoints>;
  readonly http?: typeof fetch;
  readonly now?: () => Date;
  readonly flowLifetimeMs?: number;
}
export interface KickCredentialStatus {
  readonly configured: boolean;
  readonly redirectUri: string;
}
export interface KickOAuthCallbackInput {
  readonly browserBinding?: string;
  readonly code?: string;
  readonly error?: string;
  readonly state?: string;
}
const endpoints: KickOAuthEndpoints = {
  authorization: 'https://id.kick.com/oauth/authorize',
  token: 'https://id.kick.com/oauth/token',
  user: 'https://api.kick.com/public/v1/users',
};
const clientId: SecretReference = { name: 'client-id', ownerId: 'kick', scope: 'application' };
const clientSecret: SecretReference = {
  name: 'client-secret',
  ownerId: 'kick',
  scope: 'application',
};
export function kickRefreshTokenReference(accountId: string): SecretReference {
  return { name: 'kick-refresh-token', ownerId: accountId, scope: 'account' };
}
function verifierReference(requestId: string): SecretReference {
  return { name: 'kick-oauth-pkce-verifier', ownerId: requestId, scope: 'account' };
}

/** OAuth 2.1 connector: persistent one-time state and PKCE verifier remain local-only. */
export class KickOAuthService implements KickAccessTokenProvider {
  private readonly endpoints: KickOAuthEndpoints;
  private readonly http: typeof fetch;
  private readonly now: () => Date;
  private readonly flowLifetimeMs: number;
  public constructor(
    private readonly accounts: AccountRepository,
    private readonly requests: OAuthAuthorizationRequestRepository,
    private readonly secrets: SecretStore,
    private readonly appUrl: URL,
    options: KickOAuthServiceOptions = {},
  ) {
    this.endpoints = { ...endpoints, ...options.endpoints };
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.flowLifetimeMs = options.flowLifetimeMs ?? 10 * 60_000;
  }
  public async configureCredentials(input: {
    readonly clientId: string;
    readonly clientSecret: string;
  }) {
    if (!input.clientId.trim() || !input.clientSecret.trim())
      throw failure(
        'configuration',
        'KICK_CREDENTIALS_REQUIRED',
        'A Kick client ID and client secret are required.',
      );
    const previous = await this.secrets.get(clientId);
    await this.secrets.set(clientId, input.clientId.trim());
    await this.secrets.set(clientSecret, input.clientSecret.trim());
    if (previous !== undefined && previous !== input.clientId.trim())
      this.accounts.setProviderStatus('kick', 'reauthorization_required', this.now());
  }
  public async credentialStatus(): Promise<KickCredentialStatus> {
    return {
      configured:
        (await this.secrets.get(clientId)) !== undefined &&
        (await this.secrets.get(clientSecret)) !== undefined,
      redirectUri: this.redirectUri(),
    };
  }
  public listAccounts(): readonly ConnectedAccount[] {
    return this.accounts.list();
  }
  public async removeAccount(id: string): Promise<ConnectedAccount | undefined> {
    const account = this.accounts.findById(id);
    if (account?.provider !== 'kick') return undefined;
    await this.secrets.delete(kickRefreshTokenReference(id));
    return this.accounts.remove(id);
  }
  public async beginAuthorization(
    browserBinding: string,
  ): Promise<{ readonly authorizationUrl: string; readonly expiresAt: Date }> {
    if (!browserBinding)
      throw failure(
        'authentication',
        'KICK_OAUTH_SESSION_REQUIRED',
        'A local browser session is required to connect Kick.',
      );
    const credentials = await this.credentials();
    const now = this.now();
    this.requests.deleteExpired(now);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const request: OAuthAuthorizationRequest = {
      id: randomUUID(),
      provider: 'kick',
      stateHash: hash(state),
      bindingHash: hash(browserBinding),
      redirectUri: this.redirectUri(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.flowLifetimeMs),
    };
    await this.secrets.set(verifierReference(request.id), verifier);
    this.requests.create(request);
    const url = new URL(this.endpoints.authorization);
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'user:read channel:read');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set(
      'code_challenge',
      createHash('sha256').update(verifier).digest('base64url'),
    );
    return { authorizationUrl: url.toString(), expiresAt: request.expiresAt };
  }
  public async completeAuthorization(input: KickOAuthCallbackInput): Promise<ConnectedAccount> {
    if (!input.state || !input.browserBinding)
      throw failure(
        'authentication',
        'KICK_OAUTH_STATE_INVALID',
        'The Kick authorization response has invalid state.',
      );
    const request = this.requests.consumeByStateHash(
      'kick',
      hash(input.state),
      hash(input.browserBinding),
    );
    if (request === undefined || request.expiresAt <= this.now())
      throw failure(
        'authentication',
        'KICK_OAUTH_STATE_INVALID',
        'The Kick authorization response has invalid or expired state.',
      );
    const verifier = await this.secrets.get(verifierReference(request.id));
    await this.secrets.delete(verifierReference(request.id));
    if (input.error !== undefined)
      throw failure('authorization', 'KICK_OAUTH_DENIED', 'Kick authorization was not granted.');
    if (!input.code || !verifier)
      throw failure(
        'authentication',
        'KICK_OAUTH_CODE_MISSING',
        'Kick authorization could not be completed. Connect the account again.',
      );
    const credentials = await this.credentials();
    const token = await this.token(
      new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: input.code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: request.redirectUri,
      }),
    );
    if (!token.refreshToken)
      throw failure(
        'authentication',
        'KICK_REFRESH_TOKEN_MISSING',
        'Kick did not return a refresh token. Connect the account again.',
      );
    const identity = await this.identity(token.accessToken);
    const now = this.now();
    const account = this.accounts.upsert({
      id: randomUUID(),
      provider: 'kick',
      externalId: identity.id,
      displayName: identity.name,
      status: 'connected',
      capabilities: kickCapabilities(),
      connectedAt: now,
      updatedAt: now,
    });
    await this.secrets.set(kickRefreshTokenReference(account.id), token.refreshToken);
    return account;
  }
  public async getAccessToken(accountId: string): Promise<KickAccessToken> {
    const account = this.accounts.findById(accountId);
    if (account?.provider !== 'kick' || account.status !== 'connected')
      throw failure(
        'authentication',
        'KICK_ACCOUNT_REAUTHORIZATION_REQUIRED',
        'Reconnect the Kick account to continue.',
      );
    const refreshToken = await this.secrets.get(kickRefreshTokenReference(accountId));
    if (!refreshToken)
      throw failure(
        'authentication',
        'KICK_REFRESH_TOKEN_MISSING',
        'Reconnect the Kick account to continue.',
      );
    try {
      const credentials = await this.credentials();
      const token = await this.token(
        new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      );
      if (!token.refreshToken)
        throw failure(
          'authentication',
          'KICK_REFRESH_TOKEN_MISSING',
          'Kick did not rotate the refresh token. Reconnect the account.',
        );
      await this.secrets.set(kickRefreshTokenReference(accountId), token.refreshToken);
      return { accessToken: token.accessToken };
    } catch (error) {
      if (
        error instanceof PlatformError &&
        (error.category === 'authentication' || error.category === 'authorization')
      )
        this.accounts.setStatus(accountId, 'reauthorization_required', this.now());
      throw error;
    }
  }
  private async credentials() {
    const [id, secret] = await Promise.all([
      this.secrets.get(clientId),
      this.secrets.get(clientSecret),
    ]);
    if (!id || !secret)
      throw failure(
        'configuration',
        'KICK_CREDENTIALS_NOT_CONFIGURED',
        'Configure Kick OAuth credentials before connecting.',
      );
    return { clientId: id, clientSecret: secret };
  }
  private redirectUri() {
    return new URL('/api/accounts/kick/oauth/callback', this.appUrl).toString();
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
        code: 'KICK_TOKEN_NETWORK_ERROR',
        cause,
        publicMessage: 'Kick OAuth could not be reached.',
        retryable: true,
      });
    }
    const body = await objectResponse(response);
    if (!response.ok || typeof body?.access_token !== 'string')
      throw failure(
        response.status === 401 ? 'authentication' : 'remote',
        'KICK_TOKEN_FAILED',
        'Kick could not refresh the account authorization.',
        response.status >= 500 || response.status === 429,
      );
    return {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    };
  }
  private async identity(
    accessToken: string,
  ): Promise<{ readonly id: string; readonly name: string }> {
    const body = await getJson(
      this.http,
      new URL(this.endpoints.user),
      accessToken,
      undefined,
      'KICK_IDENTITY_LOOKUP_FAILED',
    );
    const value = Array.isArray(body.data) ? object(body.data[0]) : undefined;
    const id = value?.user_id ?? value?.id;
    const name = value?.username ?? value?.slug;
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string')
      throw failure(
        'authentication',
        'KICK_IDENTITY_INVALID',
        'Reconnect the Kick account to continue.',
      );
    return { id: String(id), name };
  }
}

export interface KickSourceAdapterOptions {
  readonly apiBaseUrl?: string;
  readonly http?: typeof fetch;
}
export class KickSourceAdapter implements SourceAdapter {
  public readonly id = 'kick';
  public readonly displayName = 'Kick';
  private readonly apiBaseUrl: string;
  private readonly http: typeof fetch;
  public constructor(
    private readonly tokens: KickAccessTokenProvider,
    options: KickSourceAdapterOptions = {},
  ) {
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.kick.com';
    this.http = options.http ?? fetch;
  }
  public async capabilities(): Promise<SourceCapabilities> {
    return {
      eventIds: false,
      mediaResolution: ['local_original', 'external_downloader'],
      polling: true,
    };
  }
  public async poll(
    request: SourcePollRequest,
    context: SourceAdapterContext,
  ): Promise<SourcePollResult> {
    const config = configFor(request.configuration);
    if (request.connectionExternalId !== config.broadcasterId)
      throw failure(
        'configuration',
        'KICK_SOURCE_BROADCASTER_MISMATCH',
        'The configured Kick broadcaster is invalid.',
      );
    const token = await this.tokens.getAccessToken(config.accountId);
    const url = new URL('/public/v1/users/livestreams', this.apiBaseUrl);
    url.searchParams.append('broadcaster_user_id', config.broadcasterId);
    const body = await getJson(
      this.http,
      url,
      token.accessToken,
      context.signal,
      'KICK_SOURCE_POLL_FAILED',
    );
    const items = (Array.isArray(body.data) ? body.data : [])
      .map((value) => observation(value))
      .filter((value): value is SourceItemObservation => value !== undefined);
    return { hasMore: false, items, cursor: null };
  }
}

export const kickPluginManifest = {
  capabilities: [{ id: 'kick', kind: 'source' }],
  configurationSchema: { additionalProperties: false, properties: {}, type: 'object' },
  id: 'openrepurpose.kick',
  name: 'OpenRepurpose Kick',
  requiredApiVersion: '^1.0.0',
  permissions: {
    childProcesses: [],
    filesystem: [],
    networkHosts: ['api.kick.com', 'id.kick.com', 'kick.com'],
    secrets: [
      { access: ['read', 'write'], name: 'client-id', scope: 'application' },
      { access: ['read', 'write', 'delete'], name: 'client-secret', scope: 'application' },
      { access: ['read', 'write', 'delete'], name: 'kick-oauth-pkce-verifier', scope: 'account' },
      { access: ['read', 'write', 'delete'], name: 'kick-refresh-token', scope: 'account' },
    ],
  },
  version: '1.0.0',
} as const satisfies PluginManifest;
function configFor(value: Readonly<Record<string, SourceJsonValue>>) {
  const accountId = value.accountId;
  const broadcasterId = value.broadcasterId;
  if (
    typeof accountId !== 'string' ||
    !accountId.trim() ||
    typeof broadcasterId !== 'string' ||
    !broadcasterId.trim()
  )
    throw failure(
      'configuration',
      'KICK_SOURCE_CONFIGURATION_INVALID',
      'A connected Kick account and broadcaster ID are required.',
    );
  return { accountId, broadcasterId };
}
function observation(value: unknown): SourceItemObservation | undefined {
  const stream = object(value);
  const uuid = stream?.livestream_id ?? stream?.uuid ?? stream?.id;
  if (typeof uuid !== 'string' && typeof uuid !== 'number') return undefined;
  const slug =
    typeof stream?.slug === 'string'
      ? stream.slug
      : typeof object(stream?.channel)?.slug === 'string'
        ? (object(stream?.channel)?.slug as string)
        : undefined;
  const startedAt = stringValue(stream?.started_at ?? stream?.created_at);
  const title = stringValue(stream?.session_title ?? stream?.title);
  return {
    externalId: String(uuid),
    ...(startedAt === undefined ? {} : { publishedAt: startedAt }),
    metadata: {
      kickKind: 'active_livestream',
      ...(slug === undefined ? {} : { channelSlug: slug }),
      ...(title === undefined ? {} : { title }),
      ...(typeof stream?.viewer_count === 'number' ? { viewerCount: stream.viewer_count } : {}),
      ...(typeof stream?.language === 'string' ? { language: stream.language } : {}),
    },
    media: {
      availability: 'unavailable',
      resolutionStrategies:
        slug === undefined ? ['local_original'] : ['local_original', 'external_downloader'],
      rightsRequirement: slug === undefined ? 'connection_authorization' : 'explicit_confirmation',
      ...(slug === undefined
        ? {}
        : { externalDownload: { locator: `https://kick.com/${encodeURIComponent(slug)}` } }),
    },
  };
}
async function getJson(
  http: typeof fetch,
  url: URL,
  accessToken: string,
  signal: AbortSignal | undefined,
  code: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await http(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new PlatformError({
      category: 'network',
      code: `${code}_NETWORK_ERROR`,
      cause,
      publicMessage: 'Kick could not be reached.',
      retryable: true,
    });
  }
  const body = await objectResponse(response);
  if (!response.ok)
    throw failure(
      response.status === 401
        ? 'authentication'
        : response.status === 403
          ? 'authorization'
          : response.status === 429 || response.status >= 500
            ? 'remote'
            : 'validation',
      code,
      response.status === 401
        ? 'Reconnect the Kick account to continue.'
        : 'Kick source polling failed.',
      response.status === 429 || response.status >= 500,
      parseRetryAfterMs(response.headers.get('retry-after')),
    );
  return body ?? {};
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
async function objectResponse(response: Response) {
  try {
    return object(await response.json());
  } catch {
    return undefined;
  }
}
function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function kickCapabilities(): readonly AccountCapability[] {
  return ['kick.identity.read', 'kick.channel.read'];
}
function failure(
  category: PlatformError['category'],
  code: string,
  publicMessage: string,
  retryable = false,
  retryAfterMs?: number,
): PlatformError {
  return new PlatformError({
    category,
    code,
    publicMessage,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
