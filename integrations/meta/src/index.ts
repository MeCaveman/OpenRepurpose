import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  MetaCredential,
  MetaCredentialRepository,
  MetaPublishTarget,
  OAuthAuthorizationRequest,
  OAuthAuthorizationRequestRepository,
} from '@openrepurpose/core';
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
