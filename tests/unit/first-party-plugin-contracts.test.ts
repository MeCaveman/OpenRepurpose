import { describe, expect, it } from 'vitest';
import {
  FacebookReelsJobHandler,
  InstagramReelsJobHandler,
  metaPluginManifest,
} from '@openrepurpose/meta';
import { TikTokDirectPostJobHandler, tiktokPluginManifest } from '@openrepurpose/tiktok';
import { TwitchSourceAdapter, twitchPluginManifest } from '@openrepurpose/twitch';
import { KickSourceAdapter, kickPluginManifest } from '@openrepurpose/kick';
import {
  YouTubeSourceAdapter,
  YouTubeUploadJobHandler,
  youtubePluginManifest,
} from '@openrepurpose/youtube';
import { runPluginContract } from '@openrepurpose/testkit';

const unusedDependency = undefined as never;

describe('first-party plugin contracts', () => {
  it('certifies YouTube source and destination contributions', async () => {
    await expect(
      runPluginContract({
        destinations: [
          new YouTubeUploadJobHandler(unusedDependency, unusedDependency, unusedDependency),
        ],
        manifest: youtubePluginManifest,
        sources: [
          new YouTubeSourceAdapter({ refreshAccessToken: async () => 'unused-test-token' }),
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('certifies TikTok destination contributions', async () => {
    await expect(
      runPluginContract({
        destinations: [
          new TikTokDirectPostJobHandler(
            unusedDependency,
            unusedDependency,
            unusedDependency,
            unusedDependency,
          ),
        ],
        manifest: tiktokPluginManifest,
      }),
    ).resolves.toBeUndefined();
  });

  it('certifies Meta destination contributions', async () => {
    await expect(
      runPluginContract({
        destinations: [
          new InstagramReelsJobHandler(
            unusedDependency,
            unusedDependency,
            unusedDependency,
            unusedDependency,
          ),
          new FacebookReelsJobHandler(
            unusedDependency,
            unusedDependency,
            unusedDependency,
            unusedDependency,
          ),
        ],
        manifest: metaPluginManifest,
      }),
    ).resolves.toBeUndefined();
  });

  it('certifies Twitch and Kick source contributions', async () => {
    await expect(
      runPluginContract({
        manifest: twitchPluginManifest,
        sources: [
          new TwitchSourceAdapter({
            getAccessToken: async () => ({ accessToken: 'unused-test-token', clientId: 'test' }),
          }),
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(
      runPluginContract({
        manifest: kickPluginManifest,
        sources: [
          new KickSourceAdapter({
            getAccessToken: async () => ({ accessToken: 'unused-test-token' }),
          }),
        ],
      }),
    ).resolves.toBeUndefined();
  });
});
