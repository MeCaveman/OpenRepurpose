import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AccountCapability,
  AccountRepository,
  ConnectedAccount,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
} from '@openrepurpose/core';
import type { SecretReference, SecretStore } from '@openrepurpose/platform-sdk';
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
    if (existing === undefined) return undefined;
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
