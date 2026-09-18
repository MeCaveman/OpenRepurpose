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
      if (url.pathname.endsWith('/me/accounts'))
        return json({
          data: [
            {
              id: 'page-1',
              name: 'Creator Page',
              tasks: ['CREATE_CONTENT'],
              instagram_business_account: { id: 'ig-1', username: 'creator' },
            },
            { id: 'page-2', name: 'No publish role', tasks: [] },
          ],
        });
      throw new Error(`Unexpected ${url}`);
    };
    const service = new MetaOAuthService(
      new SqliteMetaCredentialRepository(temporary.database),
      new SqliteOAuthAuthorizationRequestRepository(temporary.database),
      new InMemorySecretStore(),
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
    expect(service.setTargetEnabled(service.listTargets()[0]!.id, false)).toBe(true);
    expect(service.listTargets()[0]!.enabled).toBe(false);
  });
});
