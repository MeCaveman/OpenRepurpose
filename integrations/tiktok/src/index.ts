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

export const TIKTOK_IDENTITY_SCOPE = 'user.info.basic';
export const TIKTOK_PUBLISH_SCOPE = 'video.publish';

const clientKeyReference: SecretReference = {
  name: 'client-key',
  ownerId: 'tiktok',
  scope: 'application',
};
const clientSecretReference: SecretReference = {
  name: 'client-secret',
  ownerId: 'tiktok',
  scope: 'application',
};

export function tiktokTokenBundleReference(accountId: string): SecretReference {
  return { name: 'tiktok-token-bundle', ownerId: accountId, scope: 'account' };
}

function verifierReference(requestId: string): SecretReference {
  return {
    name: 'code-verifier',
    ownerId: `tiktok-oauth:${requestId}`,
    scope: 'application',
  };
}

export interface TikTokOAuthEndpoints {
  readonly authorization: string;
  readonly creatorInfo: string;
  readonly token: string;
  readonly userInfo: string;
}

export interface TikTokHttpClient {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface ConfigureTikTokCredentialsInput {
  readonly clientKey: string;
  readonly clientSecret: string;
}

export interface TikTokCredentialStatus {
  readonly clientSecretConfigured: boolean;
  readonly configured: boolean;
  readonly flow: 'desktop' | 'web';
  readonly redirectUri: string;
}

export interface TikTokOAuthStart {
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
}

export interface TikTokOAuthCallbackInput {
  readonly browserBinding?: string;
  readonly code?: string;
  readonly error?: string;
  readonly state?: string;
}

export type TikTokPrivacyLevel =
  'FOLLOWER_OF_CREATOR' | 'MUTUAL_FOLLOW_FRIENDS' | 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY';

export interface TikTokAccountCapabilities {
  readonly accountId: string;
  readonly audit: {
    readonly status: 'not_exposed_by_tiktok';
    readonly unauditedClientsPrivateOnly: true;
  };
  readonly creator:
    | {
        readonly nickname: string;
        readonly username: string;
      }
    | undefined;
  readonly directPostAvailable: boolean;
  readonly grantedScopes: readonly string[];
  readonly interactions:
    | {
        readonly commentsDisabled: boolean;
        readonly duetDisabled: boolean;
        readonly stitchDisabled: boolean;
      }
    | undefined;
  readonly media:
    | {
        readonly captionMaxUtf16CodeUnits: 2200;
        readonly codecs: readonly ['H.264', 'H.265', 'VP8', 'VP9'];
        readonly formats: readonly ['MP4', 'MOV', 'WebM'];
        readonly maxFileSizeBytes: 4294967296;
        readonly maxFrameRate: 60;
        readonly maxPixelsPerDimension: 4096;
        readonly maxVideoDurationSeconds: number;
        readonly minFrameRate: 23;
        readonly minPixelsPerDimension: 360;
      }
    | undefined;
  readonly privacyLevelOptions: readonly TikTokPrivacyLevel[];
  readonly publicPostingAvailability:
    'not_authorized' | 'requires_audit_confirmation' | 'unavailable_for_creator';
}

export interface TikTokOAuthServiceOptions {
  readonly endpoints?: Partial<TikTokOAuthEndpoints>;
  readonly flowLifetimeMs?: number;
  readonly http?: TikTokHttpClient;
  readonly now?: () => Date;
}

interface TikTokCredentials {
  readonly clientKey: string;
  readonly clientSecret: string;
}

interface TokenBundle {
  readonly accessExpiresAt: number;
  readonly accessToken: string;
  readonly openId: string;
  readonly refreshExpiresAt: number;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
}

interface CreatorInfo {
  readonly commentDisabled: boolean;
  readonly duetDisabled: boolean;
  readonly maxVideoPostDurationSeconds: number;
  readonly nickname: string;
  readonly privacyLevelOptions: readonly TikTokPrivacyLevel[];
  readonly stitchDisabled: boolean;
  readonly username: string;
}

const defaultEndpoints: TikTokOAuthEndpoints = {
  authorization: 'https://www.tiktok.com/v2/auth/authorize/',
  creatorInfo: 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
  token: 'https://open.tiktokapis.com/v2/oauth/token/',
  userInfo: 'https://open.tiktokapis.com/v2/user/info/',
};

const loopbackHosts = new Set(['127.0.0.1', 'localhost']);
const privacyLevels = new Set<TikTokPrivacyLevel>([
  'FOLLOWER_OF_CREATOR',
  'MUTUAL_FOLLOW_FRIENDS',
  'PUBLIC_TO_EVERYONE',
  'SELF_ONLY',
]);

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
  if (scopes.has(TIKTOK_IDENTITY_SCOPE)) capabilities.push('tiktok.identity.read');
  if (scopes.has(TIKTOK_PUBLISH_SCOPE)) capabilities.push('tiktok.video.publish');
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

function flowForRedirect(redirectUri: string): 'desktop' | 'web' {
  const redirect = new URL(redirectUri);
  const hostname = redirect.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (loopbackHosts.has(hostname)) {
    if (
      (redirect.protocol !== 'http:' && redirect.protocol !== 'https:') ||
      redirect.port.length === 0
    )
      throw platformError(
        'configuration',
        'TIKTOK_DESKTOP_REDIRECT_INVALID',
        'TikTok desktop OAuth requires an HTTP(S) localhost or 127.0.0.1 callback with an explicit port.',
      );
    return 'desktop';
  }
  if (redirect.protocol !== 'https:')
    throw platformError(
      'configuration',
      'TIKTOK_WEB_REDIRECT_INVALID',
      'TikTok web OAuth requires a registered HTTPS callback URL.',
    );
  return 'web';
}

function parseScopes(value: unknown): readonly string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0)
    : [];
}

/** TikTok OAuth and live creator-capability application service shared by HTTP and future CLI. */
export class TikTokOAuthService {
  private readonly endpoints: TikTokOAuthEndpoints;
  private readonly flowLifetimeMs: number;
  private readonly http: TikTokHttpClient;
  private readonly now: () => Date;

  public constructor(
    private readonly accounts: AccountRepository,
    private readonly requests: OAuthAuthorizationRequestRepository,
    private readonly secrets: SecretStore,
    private readonly appUrl: URL,
    options: TikTokOAuthServiceOptions = {},
  ) {
    this.endpoints = { ...defaultEndpoints, ...options.endpoints };
    this.flowLifetimeMs = options.flowLifetimeMs ?? 10 * 60 * 1_000;
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public async configureCredentials(input: ConfigureTikTokCredentialsInput): Promise<void> {
    const clientKey = input.clientKey.trim();
    const clientSecret = input.clientSecret.trim();
    if (clientKey.length === 0 || clientSecret.length === 0)
      throw platformError(
        'configuration',
        'TIKTOK_CREDENTIALS_REQUIRED',
        'A TikTok client key and client secret are required.',
      );
    flowForRedirect(this.redirectUri());
    const previousClientKey = await this.secrets.get(clientKeyReference);
    await this.secrets.set(clientKeyReference, clientKey);
    await this.secrets.set(clientSecretReference, clientSecret);
    if (previousClientKey !== undefined && previousClientKey !== clientKey)
      this.accounts.setProviderStatus('tiktok', 'reauthorization_required', this.now());
  }

  public async credentialStatus(): Promise<TikTokCredentialStatus> {
    const redirectUri = this.redirectUri();
    const flow = flowForRedirect(redirectUri);
    const [clientKey, clientSecret] = await Promise.all([
      this.secrets.get(clientKeyReference),
      this.secrets.get(clientSecretReference),
    ]);
    return {
      configured: clientKey !== undefined && clientSecret !== undefined,
      clientSecretConfigured: clientSecret !== undefined,
      flow,
      redirectUri,
    };
  }

  public listAccounts(): readonly ConnectedAccount[] {
    return this.accounts.list();
  }

  public async removeAccount(id: string): Promise<ConnectedAccount | undefined> {
    const existing = this.accounts.findById(id);
    if (existing === undefined || existing.provider !== 'tiktok') return undefined;
    await this.secrets.delete(tiktokTokenBundleReference(id));
    return this.accounts.remove(id);
  }

  public async beginAuthorization(browserBinding: string): Promise<TikTokOAuthStart> {
    if (browserBinding.length === 0)
      throw platformError(
        'authentication',
        'TIKTOK_OAUTH_SESSION_REQUIRED',
        'A browser session is required to connect TikTok.',
      );
    const credentials = await this.requireCredentials();
    const redirectUri = this.redirectUri();
    const flow = flowForRedirect(redirectUri);
    const now = this.now();
    const expired = this.requests.deleteExpired(now);
    await Promise.all(expired.map((request) => this.secrets.delete(verifierReference(request.id))));

    const requestId = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const request: OAuthAuthorizationRequest = {
      id: requestId,
      provider: 'tiktok',
      stateHash: stateHash(state),
      bindingHash: stateHash(browserBinding),
      redirectUri,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.flowLifetimeMs),
    };
    let verifier: string | undefined;
    if (flow === 'desktop') {
      verifier = randomBytes(64).toString('base64url');
      await this.secrets.set(verifierReference(requestId), verifier);
    }
    try {
      this.requests.create(request);
    } catch (error) {
      if (verifier !== undefined) await this.secrets.delete(verifierReference(requestId));
      throw error;
    }

    const authorizationUrl = new URL(this.endpoints.authorization);
    authorizationUrl.searchParams.set('client_key', credentials.clientKey);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', `${TIKTOK_IDENTITY_SCOPE},${TIKTOK_PUBLISH_SCOPE}`);
    authorizationUrl.searchParams.set('state', state);
    if (verifier !== undefined) {
      authorizationUrl.searchParams.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('hex'),
      );
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    }
    return { authorizationUrl: authorizationUrl.toString(), expiresAt: request.expiresAt };
  }

  public async completeAuthorization(input: TikTokOAuthCallbackInput): Promise<ConnectedAccount> {
    if (input.state === undefined || input.state.length === 0)
      throw platformError(
        'authentication',
        'TIKTOK_OAUTH_STATE_INVALID',
        'The TikTok authorization response has invalid state. Start the connection again.',
      );
    const request =
      input.browserBinding === undefined
        ? undefined
        : this.requests.consumeByStateHash(stateHash(input.state), stateHash(input.browserBinding));
    if (request === undefined || request.provider !== 'tiktok')
      throw platformError(
        'authentication',
        'TIKTOK_OAUTH_STATE_INVALID',
        'The TikTok authorization response has invalid or already-used state.',
      );
    const reference = verifierReference(request.id);
    try {
      if (request.expiresAt.getTime() <= this.now().getTime())
        throw platformError(
          'authentication',
          'TIKTOK_OAUTH_STATE_EXPIRED',
          'The TikTok authorization request expired. Start the connection again.',
        );
      if (input.error !== undefined)
        throw platformError(
          'authorization',
          'TIKTOK_OAUTH_DENIED',
          'TikTok authorization was not granted.',
        );
      if (input.code === undefined || input.code.length === 0)
        throw platformError(
          'authentication',
          'TIKTOK_OAUTH_CODE_MISSING',
          'The TikTok authorization response did not include a code.',
        );
      const flow = flowForRedirect(request.redirectUri);
      const verifier = flow === 'desktop' ? await this.secrets.get(reference) : undefined;
      if (flow === 'desktop' && verifier === undefined)
        throw platformError(
          'authentication',
          'TIKTOK_OAUTH_VERIFIER_MISSING',
          'The TikTok authorization request cannot be resumed. Start the connection again.',
        );
      const credentials = await this.requireCredentials();
      const token = await this.exchangeCode(input.code, verifier, request.redirectUri, credentials);
      const capabilities = capabilitiesForScopes(new Set(token.scopes));
      if (!capabilities.includes('tiktok.identity.read'))
        throw platformError(
          'authorization',
          'TIKTOK_IDENTITY_SCOPE_MISSING',
          'TikTok profile access is required to identify the connected account.',
        );
      const identity = await this.loadIdentity(token.accessToken);
      if (identity.id !== token.openId)
        throw platformError(
          'authentication',
          'TIKTOK_IDENTITY_MISMATCH',
          'TikTok returned inconsistent account identity information. Connect again.',
        );
      const now = this.now();
      const account = this.accounts.upsert({
        id: randomUUID(),
        provider: 'tiktok',
        externalId: identity.id,
        displayName: identity.displayName,
        status: 'connected',
        capabilities,
        connectedAt: now,
        updatedAt: now,
      });
      try {
        await this.secrets.set(tiktokTokenBundleReference(account.id), JSON.stringify(token));
      } catch (error) {
        this.accounts.setStatus(account.id, 'reauthorization_required', now);
        throw error;
      }
      return account;
    } finally {
      await this.secrets.delete(reference);
    }
  }

  public async refreshAccessToken(accountId: string): Promise<string> {
    return (await this.refreshBundle(accountId)).accessToken;
  }

  public async getAccountCapabilities(accountId: string): Promise<TikTokAccountCapabilities> {
    this.requireAccount(accountId);
    const bundle = await this.usableBundle(accountId);
    const base = {
      accountId,
      audit: { status: 'not_exposed_by_tiktok', unauditedClientsPrivateOnly: true } as const,
      grantedScopes: bundle.scopes,
    };
    if (!bundle.scopes.includes(TIKTOK_PUBLISH_SCOPE))
      return {
        ...base,
        creator: undefined,
        directPostAvailable: false,
        interactions: undefined,
        media: undefined,
        privacyLevelOptions: [],
        publicPostingAvailability: 'not_authorized',
      };
    const creator = await this.loadCreatorInfo(bundle.accessToken, accountId);
    const publicOption = creator.privacyLevelOptions.includes('PUBLIC_TO_EVERYONE');
    return {
      ...base,
      creator: { nickname: creator.nickname, username: creator.username },
      directPostAvailable: true,
      interactions: {
        commentsDisabled: creator.commentDisabled,
        duetDisabled: creator.duetDisabled,
        stitchDisabled: creator.stitchDisabled,
      },
      media: {
        captionMaxUtf16CodeUnits: 2200,
        codecs: ['H.264', 'H.265', 'VP8', 'VP9'],
        formats: ['MP4', 'MOV', 'WebM'],
        maxFileSizeBytes: 4_294_967_296,
        maxFrameRate: 60,
        maxPixelsPerDimension: 4096,
        maxVideoDurationSeconds: Math.min(600, creator.maxVideoPostDurationSeconds),
        minFrameRate: 23,
        minPixelsPerDimension: 360,
      },
      privacyLevelOptions: creator.privacyLevelOptions,
      publicPostingAvailability: publicOption
        ? 'requires_audit_confirmation'
        : 'unavailable_for_creator',
    };
  }

  private requireAccount(accountId: string): ConnectedAccount {
    const account = this.accounts.findById(accountId);
    if (account === undefined || account.provider !== 'tiktok')
      throw platformError(
        'configuration',
        'TIKTOK_ACCOUNT_NOT_FOUND',
        'The TikTok account was not found.',
      );
    if (account.status === 'reauthorization_required')
      throw platformError(
        'authentication',
        'TIKTOK_REAUTHORIZATION_REQUIRED',
        'Reconnect the TikTok account to continue.',
      );
    return account;
  }

  private async usableBundle(accountId: string): Promise<TokenBundle> {
    this.requireAccount(accountId);
    const bundle = await this.readBundle(accountId);
    if (bundle.accessExpiresAt > this.now().getTime() + 5 * 60 * 1_000) return bundle;
    return this.refreshBundle(accountId);
  }

  private async refreshBundle(accountId: string): Promise<TokenBundle> {
    const account = this.requireAccount(accountId);
    const existing = await this.readBundle(accountId);
    const credentials = await this.requireCredentials();
    const result = await this.postToken(
      new URLSearchParams({
        client_key: credentials.clientKey,
        client_secret: credentials.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: existing.refreshToken,
      }),
    );
    if (!result.response.ok) {
      const remoteCode =
        typeof result.body?.error === 'string' ? result.body.error : 'token_refresh_failed';
      if (remoteCode === 'invalid_grant')
        this.accounts.setStatus(accountId, 'reauthorization_required', this.now());
      throw platformError(
        remoteCode === 'invalid_client' ? 'configuration' : 'authentication',
        remoteCode === 'invalid_client'
          ? 'TIKTOK_OAUTH_CLIENT_INVALID'
          : 'TIKTOK_TOKEN_REFRESH_FAILED',
        remoteCode === 'invalid_client'
          ? 'The configured TikTok client credentials were rejected.'
          : 'The TikTok account must be reconnected.',
      );
    }
    const token = this.parseTokenResponse(result.body);
    if (token.openId !== account.externalId)
      throw platformError(
        'authentication',
        'TIKTOK_IDENTITY_MISMATCH',
        'TikTok refreshed credentials for a different account. Reconnect the account.',
      );
    await this.secrets.set(tiktokTokenBundleReference(accountId), JSON.stringify(token));
    const capabilities = capabilitiesForScopes(new Set(token.scopes));
    this.accounts.upsert({
      ...account,
      capabilities,
      status: 'connected',
      updatedAt: this.now(),
    });
    return token;
  }

  private async exchangeCode(
    code: string,
    verifier: string | undefined,
    redirectUri: string,
    credentials: TikTokCredentials,
  ): Promise<TokenBundle> {
    const form = new URLSearchParams({
      client_key: credentials.clientKey,
      client_secret: credentials.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (verifier !== undefined) form.set('code_verifier', verifier);
    const result = await this.postToken(form);
    if (!result.response.ok)
      throw platformError(
        result.response.status === 401 ? 'authentication' : 'remote',
        'TIKTOK_TOKEN_EXCHANGE_FAILED',
        'TikTok rejected the authorization response. Start the connection again.',
        result.response.status >= 500,
      );
    return this.parseTokenResponse(result.body);
  }

  private parseTokenResponse(body: Record<string, unknown> | undefined): TokenBundle {
    if (
      typeof body?.access_token !== 'string' ||
      typeof body.expires_in !== 'number' ||
      typeof body.open_id !== 'string' ||
      typeof body.refresh_expires_in !== 'number' ||
      typeof body.refresh_token !== 'string'
    )
      throw platformError(
        'remote',
        'TIKTOK_TOKEN_RESPONSE_INVALID',
        'TikTok returned an invalid OAuth token response.',
      );
    const now = this.now().getTime();
    return {
      accessToken: body.access_token,
      accessExpiresAt: now + body.expires_in * 1_000,
      openId: body.open_id,
      refreshToken: body.refresh_token,
      refreshExpiresAt: now + body.refresh_expires_in * 1_000,
      scopes: parseScopes(body.scope),
    };
  }

  private async readBundle(accountId: string): Promise<TokenBundle> {
    const serialized = await this.secrets.get(tiktokTokenBundleReference(accountId));
    if (serialized === undefined)
      throw platformError(
        'authentication',
        'TIKTOK_TOKEN_BUNDLE_MISSING',
        'Reconnect the TikTok account to continue.',
      );
    try {
      const value = JSON.parse(serialized) as Partial<TokenBundle>;
      if (
        typeof value.accessToken !== 'string' ||
        typeof value.accessExpiresAt !== 'number' ||
        typeof value.openId !== 'string' ||
        typeof value.refreshToken !== 'string' ||
        typeof value.refreshExpiresAt !== 'number' ||
        !Array.isArray(value.scopes) ||
        value.scopes.some((scope) => typeof scope !== 'string')
      )
        throw new Error('invalid token bundle');
      return value as TokenBundle;
    } catch (error) {
      throw platformError(
        'authentication',
        'TIKTOK_TOKEN_BUNDLE_INVALID',
        'The saved TikTok credentials are invalid. Reconnect the account.',
        false,
        error,
      );
    }
  }

  private async loadIdentity(
    accessToken: string,
  ): Promise<{ readonly displayName: string; readonly id: string }> {
    const url = new URL(this.endpoints.userInfo);
    url.searchParams.set('fields', 'open_id,display_name');
    const { response, body } = await this.requestJson(
      url,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        method: 'GET',
      },
      'TIKTOK_IDENTITY_NETWORK_ERROR',
      'TikTok could not be reached while loading the account identity.',
    );
    const error = safeJsonObject(body?.error);
    const user = safeJsonObject(safeJsonObject(body?.data)?.user);
    if (!response.ok || error?.code !== 'ok')
      throw platformError(
        response.status === 401 ? 'authentication' : 'remote',
        'TIKTOK_IDENTITY_FAILED',
        'The connected TikTok account identity could not be loaded.',
        response.status >= 500,
      );
    if (typeof user?.open_id !== 'string' || typeof user.display_name !== 'string')
      throw platformError(
        'remote',
        'TIKTOK_IDENTITY_RESPONSE_INVALID',
        'TikTok returned an invalid account identity.',
      );
    return { id: user.open_id, displayName: user.display_name };
  }

  private async loadCreatorInfo(accessToken: string, accountId: string): Promise<CreatorInfo> {
    const { response, body } = await this.requestJson(
      this.endpoints.creatorInfo,
      {
        body: '{}',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        method: 'POST',
      },
      'TIKTOK_CREATOR_INFO_NETWORK_ERROR',
      'TikTok could not be reached while checking posting availability.',
    );
    const error = safeJsonObject(body?.error);
    const remoteCode = typeof error?.code === 'string' ? error.code : 'creator_info_failed';
    if (!response.ok || remoteCode !== 'ok') {
      if (response.status === 401 || remoteCode === 'access_token_invalid')
        this.accounts.setStatus(accountId, 'reauthorization_required', this.now());
      const limited = remoteCode.includes('too_many') || remoteCode.includes('spam_risk');
      throw platformError(
        response.status === 401 ? 'authentication' : limited ? 'quota' : 'remote',
        `TIKTOK_CREATOR_INFO_${remoteCode.toUpperCase()}`,
        limited
          ? 'TikTok says this creator cannot make another post right now. Try again later.'
          : remoteCode === 'scope_not_authorized'
            ? 'This TikTok account did not grant Direct Post access. Reconnect and grant video.publish.'
            : 'TikTok posting availability could not be loaded.',
        response.status >= 500 || response.status === 429,
      );
    }
    const data = safeJsonObject(body?.data);
    const options = data?.privacy_level_options;
    if (
      typeof data?.creator_username !== 'string' ||
      typeof data.creator_nickname !== 'string' ||
      typeof data.comment_disabled !== 'boolean' ||
      typeof data.duet_disabled !== 'boolean' ||
      typeof data.stitch_disabled !== 'boolean' ||
      typeof data.max_video_post_duration_sec !== 'number' ||
      !Array.isArray(options) ||
      options.some(
        (option) => typeof option !== 'string' || !privacyLevels.has(option as TikTokPrivacyLevel),
      )
    )
      throw platformError(
        'remote',
        'TIKTOK_CREATOR_INFO_RESPONSE_INVALID',
        'TikTok returned invalid creator posting information.',
      );
    return {
      username: data.creator_username,
      nickname: data.creator_nickname,
      commentDisabled: data.comment_disabled,
      duetDisabled: data.duet_disabled,
      stitchDisabled: data.stitch_disabled,
      maxVideoPostDurationSeconds: data.max_video_post_duration_sec,
      privacyLevelOptions: options as TikTokPrivacyLevel[],
    };
  }

  private async requestJson(
    input: string | URL,
    init: RequestInit,
    networkCode: string,
    networkMessage: string,
  ): Promise<{ readonly body: Record<string, unknown> | undefined; readonly response: Response }> {
    let response: Response;
    try {
      response = await this.http(input, init);
    } catch (error) {
      throw platformError('network', networkCode, networkMessage, true, error);
    }
    return { response, body: await responseJson(response) };
  }

  private async postToken(form: URLSearchParams): Promise<{
    readonly body: Record<string, unknown> | undefined;
    readonly response: Response;
  }> {
    return this.requestJson(
      this.endpoints.token,
      {
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      },
      'TIKTOK_TOKEN_NETWORK_ERROR',
      'TikTok OAuth could not be reached.',
    );
  }

  private redirectUri(): string {
    return new URL('/api/accounts/tiktok/oauth/callback', this.appUrl).toString();
  }

  private async requireCredentials(): Promise<TikTokCredentials> {
    const [clientKey, clientSecret] = await Promise.all([
      this.secrets.get(clientKeyReference),
      this.secrets.get(clientSecretReference),
    ]);
    if (clientKey === undefined || clientSecret === undefined)
      throw platformError(
        'configuration',
        'TIKTOK_CREDENTIALS_NOT_CONFIGURED',
        'Configure TikTok Login Kit credentials before connecting TikTok.',
      );
    return { clientKey, clientSecret };
  }
}
