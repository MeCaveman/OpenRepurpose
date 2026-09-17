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
  MediaAsset,
  MediaRepository,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
} from '@openrepurpose/core';
import { JobExecutionError } from '@openrepurpose/core';
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

/** The expiring TikTok upload URL contains authorization material and never enters SQLite. */
export function tiktokUploadUrlReference(jobId: string): SecretReference {
  return { name: 'tiktok-upload-url', ownerId: `tiktok-upload:${jobId}`, scope: 'application' };
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

const defaultPublishEndpoints = {
  init: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
  status: 'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
};

export const TIKTOK_DIRECT_POST_JOB_TYPE = 'tiktok.direct-post';

export interface TikTokDirectPostJobInput {
  readonly accountId: string;
  readonly mediaId: string;
  readonly metadata: {
    readonly caption?: string;
    readonly disableComment?: boolean;
    readonly disableDuet?: boolean;
    readonly disableStitch?: boolean;
    readonly privacyLevel: TikTokPrivacyLevel;
  };
}

export interface TikTokDirectPostJobHandlerOptions {
  readonly chunkSizeBytes?: number;
  readonly endpoints?: Partial<typeof defaultPublishEndpoints>;
  readonly http?: TikTokHttpClient;
  readonly now?: () => Date;
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

function isJsonRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function directPostInput(value: JsonValue): TikTokDirectPostJobInput {
  if (
    !isJsonRecord(value) ||
    typeof value.accountId !== 'string' ||
    typeof value.mediaId !== 'string'
  )
    throw new JobExecutionError(
      'TIKTOK_DIRECT_POST_INPUT_INVALID',
      false,
      'The TikTok publish job is invalid.',
    );
  const metadata = value.metadata;
  if (
    !isJsonRecord(metadata) ||
    typeof metadata.privacyLevel !== 'string' ||
    !privacyLevels.has(metadata.privacyLevel as TikTokPrivacyLevel)
  )
    throw new JobExecutionError(
      'TIKTOK_PRIVACY_LEVEL_INVALID',
      false,
      'Choose a privacy level offered by TikTok for this creator.',
    );
  for (const key of ['disableComment', 'disableDuet', 'disableStitch'] as const) {
    if (metadata[key] !== undefined && typeof metadata[key] !== 'boolean')
      throw new JobExecutionError(
        'TIKTOK_DIRECT_POST_INPUT_INVALID',
        false,
        'The TikTok publish options are invalid.',
      );
  }
  if (metadata.caption !== undefined && typeof metadata.caption !== 'string')
    throw new JobExecutionError(
      'TIKTOK_DIRECT_POST_INPUT_INVALID',
      false,
      'The TikTok caption is invalid.',
    );
  return {
    accountId: value.accountId,
    mediaId: value.mediaId,
    metadata: {
      privacyLevel: metadata.privacyLevel as TikTokPrivacyLevel,
      ...(typeof metadata.caption === 'string' ? { caption: metadata.caption } : {}),
      ...(typeof metadata.disableComment === 'boolean'
        ? { disableComment: metadata.disableComment }
        : {}),
      ...(typeof metadata.disableDuet === 'boolean' ? { disableDuet: metadata.disableDuet } : {}),
      ...(typeof metadata.disableStitch === 'boolean'
        ? { disableStitch: metadata.disableStitch }
        : {}),
    },
  };
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  const seconds = value === null ? Number.NaN : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined;
}

function remoteErrorCode(body: Record<string, unknown> | undefined): string {
  const error = safeJsonObject(body?.error);
  return typeof error?.code === 'string' ? error.code : 'request_failed';
}

function requestFailure(
  response: Response,
  body: Record<string, unknown> | undefined,
  operation: 'init' | 'status',
): JobExecutionError {
  const code = remoteErrorCode(body);
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const unavailable = new Set([
    'unaudited_client_can_only_post_to_private_accounts',
    'privacy_level_option_mismatch',
    'spam_risk_too_many_posts',
    'spam_risk_user_banned_from_posting',
    'reached_active_user_cap',
  ]);
  return new JobExecutionError(
    `TIKTOK_${operation.toUpperCase()}_${code.toUpperCase()}`,
    retryable,
    unavailable.has(code)
      ? 'TikTok cannot accept this post with the selected account or privacy settings.'
      : response.status === 401
        ? 'Reconnect the TikTok account to continue publishing.'
        : retryable
          ? 'TikTok is temporarily unavailable. The publish job will retry.'
          : 'TikTok rejected the publish request.',
    retryAfterMs(response),
  );
}

function uploadFailure(response: Response): JobExecutionError {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new JobExecutionError(
    response.status === 403 || response.status === 404
      ? 'TIKTOK_UPLOAD_URL_EXPIRED'
      : response.status === 416
        ? 'TIKTOK_UPLOAD_RANGE_CONFLICT'
        : response.status === 429
          ? 'TIKTOK_UPLOAD_RATE_LIMITED'
          : 'TIKTOK_UPLOAD_FAILED',
    retryable,
    response.status === 403 || response.status === 404
      ? 'TikTok no longer accepts this upload URL. The existing post cannot be safely resumed.'
      : retryable
        ? 'TikTok is temporarily unavailable. The upload will retry at the last confirmed chunk.'
        : 'TikTok rejected this upload chunk.',
    retryAfterMs(response),
  );
}

function mimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  return undefined;
}

function utf16Length(value: string): number {
  return value.length;
}

interface UploadUrlLease {
  readonly expiresAt: number;
  readonly uploadUrl: string;
}

/**
 * Direct Post transport. It records TikTok's durable publish ID in the ordinary destination
 * checkpoint, but stores the short-lived signed upload URL only in SecretStore. A missing or
 * expired URL after an interrupted transfer deliberately fails safely instead of creating a
 * second Direct Post.
 */
export class TikTokDirectPostJobHandler implements JobHandler {
  public readonly type = TIKTOK_DIRECT_POST_JOB_TYPE;
  private readonly chunkSizeBytes: number;
  private readonly endpoints: typeof defaultPublishEndpoints;
  private readonly http: TikTokHttpClient;
  private readonly now: () => Date;

  public constructor(
    private readonly media: MediaRepository,
    private readonly checkpoints: DestinationJobRepository,
    private readonly oauth: TikTokOAuthService,
    private readonly secrets: SecretStore,
    options: TikTokDirectPostJobHandlerOptions = {},
  ) {
    this.endpoints = { ...defaultPublishEndpoints, ...options.endpoints };
    this.http = options.http ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.chunkSizeBytes = options.chunkSizeBytes ?? 10 * 1024 * 1024;
    if (
      !Number.isInteger(this.chunkSizeBytes) ||
      this.chunkSizeBytes < 5 * 1024 * 1024 ||
      this.chunkSizeBytes > 64 * 1024 * 1024
    )
      throw new Error('TikTok upload chunks must be between 5 MiB and 64 MiB.');
  }

  public async execute(inputValue: JsonValue, context: JobHandlerContext): Promise<void> {
    const input = directPostInput(inputValue);
    const asset = this.media.list().find((candidate) => candidate.id === input.mediaId);
    if (asset === undefined || asset.state !== 'available')
      throw new JobExecutionError(
        'TIKTOK_UPLOAD_MEDIA_UNAVAILABLE',
        false,
        'The selected media file is unavailable.',
      );
    this.validateMedia(asset, input);

    let checkpoint = this.checkpoints.find(context.jobId) ?? {
      destinationId: 'tiktok',
      jobId: context.jobId,
      remoteStatus: 'uploading',
      uploadedBytes: 0,
      updatedAt: this.now(),
    };
    if (checkpoint.remoteId !== undefined && checkpoint.uploadedBytes >= asset.sizeBytes)
      return this.poll(checkpoint, input.accountId, context);

    const capabilities = await this.oauth.getAccountCapabilities(input.accountId);
    this.validateCreatorOptions(capabilities, input, asset);
    const accessToken = await this.accessToken(input.accountId);
    if (checkpoint.remoteId === undefined)
      checkpoint = await this.initialize(input, asset, accessToken, checkpoint, context.jobId);
    const lease = await this.readLease(context.jobId);
    if (lease === undefined || lease.expiresAt <= this.now().getTime())
      throw new JobExecutionError(
        'TIKTOK_UPLOAD_RECOVERY_AMBIGUOUS',
        false,
        'TikTok upload recovery needs a valid upload URL. The existing post will not be duplicated automatically.',
      );

    while (checkpoint.uploadedBytes < asset.sizeBytes) {
      if (context.signal.aborted)
        throw new JobExecutionError(
          'TIKTOK_UPLOAD_CANCELLED',
          false,
          'The TikTok upload was cancelled.',
        );
      if (lease.expiresAt <= this.now().getTime())
        throw new JobExecutionError(
          'TIKTOK_UPLOAD_RECOVERY_AMBIGUOUS',
          false,
          'TikTok upload recovery needs a valid upload URL. The existing post will not be duplicated automatically.',
        );
      const start = checkpoint.uploadedBytes;
      const end = Math.min(asset.sizeBytes - 1, start + this.chunkSize(asset.sizeBytes) - 1);
      let response: Response;
      try {
        response = await this.http(lease.uploadUrl, {
          body: createReadStream(asset.path, { start, end }),
          duplex: 'half',
          headers: {
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${asset.sizeBytes}`,
            'Content-Type': mimeType(asset.path)!,
          },
          method: 'PUT',
          signal: context.signal,
        } as RequestInit);
      } catch {
        throw new JobExecutionError(
          'TIKTOK_UPLOAD_NETWORK_ERROR',
          true,
          'TikTok could not be reached. The upload will retry at the last confirmed chunk.',
        );
      }
      if (response.status === 206) {
        checkpoint = this.save({ ...checkpoint, uploadedBytes: end + 1 });
        continue;
      }
      if (response.status !== 201) throw uploadFailure(response);
      if (end !== asset.sizeBytes - 1)
        throw new JobExecutionError(
          'TIKTOK_UPLOAD_RESPONSE_INVALID',
          true,
          'TikTok completed the upload before all file chunks were sent.',
        );
      checkpoint = this.save({
        ...checkpoint,
        remoteStatus: 'processing',
        uploadedBytes: asset.sizeBytes,
      });
      await this.secrets.delete(tiktokUploadUrlReference(context.jobId));
    }
    return this.poll(checkpoint, input.accountId, context);
  }

  private validateMedia(asset: MediaAsset, input: TikTokDirectPostJobInput): void {
    const type = mimeType(asset.path);
    if (type === undefined || asset.sizeBytes <= 0 || asset.sizeBytes > 4_294_967_296)
      throw new JobExecutionError(
        'TIKTOK_UPLOAD_MEDIA_INVALID',
        false,
        'TikTok Direct Post accepts a non-empty MP4, MOV, or WebM video up to 4 GB.',
      );
    if (input.metadata.caption !== undefined && utf16Length(input.metadata.caption) > 2_200)
      throw new JobExecutionError(
        'TIKTOK_CAPTION_TOO_LONG',
        false,
        'TikTok captions are limited to 2,200 UTF-16 code units.',
      );
  }

  private validateCreatorOptions(
    capabilities: TikTokAccountCapabilities,
    input: TikTokDirectPostJobInput,
    asset: MediaAsset,
  ): void {
    if (!capabilities.directPostAvailable || capabilities.media === undefined)
      throw new JobExecutionError(
        'TIKTOK_DIRECT_POST_NOT_AUTHORIZED',
        false,
        'This TikTok account did not grant Direct Post access.',
      );
    if (!capabilities.privacyLevelOptions.includes(input.metadata.privacyLevel))
      throw new JobExecutionError(
        'TIKTOK_PRIVACY_LEVEL_UNAVAILABLE',
        false,
        'The selected TikTok privacy level is not currently available for this creator.',
      );
    if (
      asset.metadata.durationSeconds !== undefined &&
      asset.metadata.durationSeconds > capabilities.media.maxVideoDurationSeconds
    )
      throw new JobExecutionError(
        'TIKTOK_VIDEO_DURATION_EXCEEDED',
        false,
        'This video is longer than the current TikTok limit for this creator.',
      );
  }

  private async initialize(
    input: TikTokDirectPostJobInput,
    asset: MediaAsset,
    accessToken: string,
    checkpoint: DestinationJobRecord,
    jobId: string,
  ): Promise<DestinationJobRecord> {
    const chunkSize = this.chunkSize(asset.sizeBytes);
    let response: Response;
    try {
      response = await this.http(this.endpoints.init, {
        body: JSON.stringify({
          post_info: {
            privacy_level: input.metadata.privacyLevel,
            ...(input.metadata.caption === undefined ? {} : { title: input.metadata.caption }),
            ...(input.metadata.disableComment === undefined
              ? {}
              : { disable_comment: input.metadata.disableComment }),
            ...(input.metadata.disableDuet === undefined
              ? {}
              : { disable_duet: input.metadata.disableDuet }),
            ...(input.metadata.disableStitch === undefined
              ? {}
              : { disable_stitch: input.metadata.disableStitch }),
          },
          source_info: {
            chunk_size: chunkSize,
            source: 'FILE_UPLOAD',
            total_chunk_count: Math.ceil(asset.sizeBytes / chunkSize),
            video_size: asset.sizeBytes,
          },
        }),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        method: 'POST',
      });
    } catch {
      throw new JobExecutionError(
        'TIKTOK_INIT_NETWORK_ERROR',
        true,
        'TikTok could not be reached. The publish job will retry before creating a post.',
      );
    }
    const body = await responseJson(response);
    if (!response.ok || remoteErrorCode(body) !== 'ok')
      throw requestFailure(response, body, 'init');
    const data = safeJsonObject(body?.data);
    if (typeof data?.publish_id !== 'string' || typeof data.upload_url !== 'string')
      throw new JobExecutionError(
        'TIKTOK_INIT_RESPONSE_INVALID',
        true,
        'TikTok returned an invalid upload initialization response.',
      );
    // Checkpoint the durable remote operation first. If secret persistence fails, recovery refuses
    // to create a second Direct Post rather than losing the only evidence of the first one.
    const saved = this.save({
      ...checkpoint,
      remoteId: data.publish_id,
      remoteStatus: 'uploading',
    });
    await this.secrets.set(
      tiktokUploadUrlReference(jobId),
      JSON.stringify({
        expiresAt: this.now().getTime() + 60 * 60 * 1_000,
        uploadUrl: data.upload_url,
      }),
    );
    return saved;
  }

  private async poll(
    checkpoint: DestinationJobRecord,
    accountId: string,
    context: JobHandlerContext,
  ): Promise<void> {
    if (checkpoint.remoteId === undefined)
      throw new JobExecutionError(
        'TIKTOK_PUBLISH_ID_MISSING',
        true,
        'TikTok publish status is not available yet.',
      );
    let response: Response;
    try {
      response = await this.http(this.endpoints.status, {
        body: JSON.stringify({ publish_id: checkpoint.remoteId }),
        headers: {
          Authorization: `Bearer ${await this.accessToken(accountId)}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        method: 'POST',
        signal: context.signal,
      });
    } catch {
      throw new JobExecutionError(
        'TIKTOK_STATUS_NETWORK_ERROR',
        true,
        'TikTok publish status could not be loaded.',
      );
    }
    const body = await responseJson(response);
    if (!response.ok || remoteErrorCode(body) !== 'ok')
      throw requestFailure(response, body, 'status');
    const data = safeJsonObject(body?.data);
    const status = data?.status;
    if (status === 'PROCESSING_UPLOAD') {
      this.save({ ...checkpoint, remoteStatus: 'processing' });
      throw new JobExecutionError(
        'TIKTOK_PROCESSING',
        true,
        'TikTok is still processing the uploaded video.',
      );
    }
    if (status === 'PUBLISH_COMPLETE') {
      this.save({ ...checkpoint, remoteStatus: 'published' });
      return;
    }
    if (status === 'FAILED') {
      const reason = typeof data?.fail_reason === 'string' ? data.fail_reason : 'unknown';
      this.save({ ...checkpoint, remoteStatus: 'failed' });
      throw new JobExecutionError(
        `TIKTOK_PUBLISH_FAILED_${reason.toUpperCase()}`,
        reason === 'internal',
        'TikTok failed to publish this video.',
      );
    }
    throw new JobExecutionError(
      'TIKTOK_STATUS_RESPONSE_INVALID',
      true,
      'TikTok returned an invalid publish status.',
    );
  }

  private chunkSize(sizeBytes: number): number {
    return sizeBytes < 5 * 1024 * 1024 ? sizeBytes : Math.min(this.chunkSizeBytes, sizeBytes);
  }

  private async readLease(jobId: string): Promise<UploadUrlLease | undefined> {
    const stored = await this.secrets.get(tiktokUploadUrlReference(jobId));
    if (stored === undefined) return undefined;
    try {
      const value = JSON.parse(stored) as Partial<UploadUrlLease>;
      if (typeof value.uploadUrl !== 'string' || typeof value.expiresAt !== 'number')
        return undefined;
      return { uploadUrl: value.uploadUrl, expiresAt: value.expiresAt };
    } catch {
      return undefined;
    }
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

  private save(record: Omit<DestinationJobRecord, 'updatedAt'>): DestinationJobRecord {
    return this.checkpoints.save({ ...record, updatedAt: this.now() });
  }
}
