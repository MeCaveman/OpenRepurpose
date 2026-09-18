import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteMetaCredentialRepository,
  SqliteOAuthAuthorizationRequestRepository,
} from '@openrepurpose/db';
import { MetaOAuthService } from '@openrepurpose/meta';
import { InMemorySecretStore, createTemporaryDatabase } from '@openrepurpose/testkit';
import type { TemporaryDatabase } from '@openrepurpose/testkit';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Meta credential and publish-target service', () => {
  let temporary: TemporaryDatabase | undefined;
  afterEach(() => temporary?.dispose());

  it('keeps identity separate from discovered Page and Instagram targets and refreshes an expired token', async () => {
    temporary = createTemporaryDatabase();
    let refreshed = false;
    let discoveredPages: readonly Record<string, unknown>[] = [
      {
        id: 'page-1',
        name: 'Creator Page',
        tasks: ['CREATE_CONTENT'],
        access_token: 'page-token',
        instagram_business_account: { id: 'ig-1', username: 'creator' },
      },
      { id: 'page-2', name: 'No publish role', tasks: [] },
    ];
    const http = async (input: string | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith('/oauth/access_token'))
        return json({
          access_token: refreshed ? 'renewed-token' : 'initial-token',
          expires_in: refreshed ? 5_184_000 : 1,
        });
      if (url.pathname.endsWith('/me')) return json({ id: 'person-1', name: 'Meta Creator' });
      if (url.pathname.endsWith('/me/permissions'))
        return json({
          data: ['pages_manage_posts', 'instagram_basic', 'instagram_content_publish'].map(
            (permission) => ({ permission, status: 'granted' }),
          ),
        });
      if (url.pathname.endsWith('/me/accounts')) return json({ data: discoveredPages });
      throw new Error(`Unexpected ${url}`);
    };
    const secrets = new InMemorySecretStore();
    const credentials = new SqliteMetaCredentialRepository(temporary.database);
    const service = new MetaOAuthService(
      credentials,
      new SqliteOAuthAuthorizationRequestRepository(temporary.database),
      secrets,
      new URL('http://127.0.0.1:3000'),
      { http, now: () => new Date('2026-09-18T10:00:00.000Z') },
    );
    await service.configureCredentials({
      clientId: 'meta-app-id',
      clientSecret: 'meta-app-secret',
    });
    const start = await service.beginAuthorization('browser-binding');
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const credential = await service.completeAuthorization({
      browserBinding: 'browser-binding',
      code: 'safe-code',
      state,
    });
    expect(credential).toMatchObject({
      displayName: 'Meta Creator',
      externalId: 'person-1',
      status: 'connected',
    });
    expect(service.listCredentials()).toHaveLength(1);
    expect(service.listTargets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'facebook_page', externalId: 'page-1', enabled: true }),
        expect.objectContaining({
          kind: 'instagram_professional',
          externalId: 'ig-1',
          username: 'creator',
          enabled: true,
        }),
        expect.objectContaining({ externalId: 'page-2', availability: 'blocked', enabled: false }),
      ]),
    );
    refreshed = true;
    expect(await service.refreshAccessToken(credential.id)).toBe('renewed-token');
    const pageTarget = service.listTargets().find((target) => target.externalId === 'page-1')!;
    expect(service.setTargetEnabled(pageTarget.id, false)).toBe(true);
    expect(credentials.listTargets().find((target) => target.id === pageTarget.id)?.enabled).toBe(
      false,
    );

    discoveredPages = [];
    await service.discoverTargets(credential.id);
    expect(credentials.listTargets(credential.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ availability: 'blocked', enabled: false, externalId: 'page-1' }),
        expect.objectContaining({ availability: 'blocked', enabled: false, externalId: 'ig-1' }),
      ]),
    );
    expect(
      await secrets.get({ name: 'meta-page-token', ownerId: pageTarget.id, scope: 'account' }),
    ).toBeUndefined();
  });
});
