import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createMcpServer, serveMcpStdio } from '@openrepurpose/server';
import { JobService } from '@openrepurpose/core';
import { SqliteJobRepository, SqliteMediaRepository } from '@openrepurpose/db';
import { createTemporaryDatabase, type TemporaryDatabase } from '@openrepurpose/testkit';

describe('MCP boundary', () => {
  let temporary: TemporaryDatabase | undefined;

  afterEach(() => temporary?.dispose());

  function createServer() {
    temporary = createTemporaryDatabase();
    const media = new SqliteMediaRepository(temporary.database);
    const jobs = new JobService(new SqliteJobRepository(temporary.database));
    return { jobs, media, mcp: createMcpServer({ jobService: jobs, mediaRepository: media }) };
  }

  it('negotiates MCP tools and declares read and side-effect annotations', async () => {
    const { mcp } = createServer();
    const initialized = await mcp.handle({ id: 1, jsonrpc: '2.0', method: 'initialize' });
    expect(initialized).toMatchObject({
      id: 1,
      jsonrpc: '2.0',
      result: { protocolVersion: '2025-03-26', serverInfo: { name: 'openrepurpose' } },
    });
    expect(
      await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeUndefined();

    const listed = await mcp.handle({ id: 2, jsonrpc: '2.0', method: 'tools/list' });
    const tools = listed?.result as {
      tools: readonly {
        annotations: Record<string, boolean>;
        inputSchema: unknown;
        name: string;
      }[];
    };
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'get_status',
      'list_accounts',
      'list_media',
      'list_workflows',
      'list_jobs',
      'get_job',
      'run_workflow',
      'publish_media',
      'schedule_workflow',
      'cancel_job',
    ]);
    expect(tools.tools.find((tool) => tool.name === 'list_media')?.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(tools.tools.find((tool) => tool.name === 'publish_media')?.annotations).toEqual({
      destructiveHint: true,
    });
    expect(tools.tools.find((tool) => tool.name === 'publish_media')?.inputSchema).toMatchObject({
      oneOf: expect.any(Array),
    });
    expect(tools.tools.map((tool) => tool.name)).not.toContain('shell');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('read_file');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('sql');
  });

  it('enforces strict schemas, redacts media paths, and maps publishing to JobService', async () => {
    const { jobs, mcp, media } = createServer();
    media.create({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      fingerprint: 'never-exposed',
      id: 'media-1',
      metadata: { hasAudio: true },
      modifiedAt: new Date('2026-01-01T00:00:00Z'),
      path: resolve('test-results/private/source.mp4'),
      sizeBytes: 10,
      state: 'available',
    });
    const mediaResult = await mcp.handle({
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { limit: 1 }, name: 'list_media' },
    });
    const mediaText = (mediaResult?.result as { content: readonly { text: string }[] }).content[0]!
      .text;
    expect(mediaText).toContain('media-1');
    expect(mediaText).not.toContain('private');
    expect(mediaText).not.toContain('never-exposed');

    const rejected = await mcp.handle({
      id: 4,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { limit: 1, path: '../secret' }, name: 'list_media' },
    });
    expect(rejected?.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('VALIDATION_FAILED') }],
    });

    const published = await mcp.handle({
      id: 5,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {
          accountId: 'account-1',
          idempotencyKey: 'publish-1',
          mediaId: 'media-1',
          metadata: { title: 'Safe publish' },
          platform: 'youtube',
        },
        name: 'publish_media',
      },
    });
    expect(published?.result).not.toHaveProperty('isError');
    expect(jobs.list()).toHaveLength(1);
    expect(jobs.list()[0]).toMatchObject({ status: 'pending', type: 'youtube.upload' });
  });

  it('returns JSON-RPC errors for invalid protocol methods without exposing implementation details', async () => {
    const { mcp } = createServer();
    expect(await mcp.handle({ id: 'x', jsonrpc: '2.0', method: 'filesystem/read' })).toEqual({
      error: { code: -32601, message: 'Method not found.' },
      id: 'x',
      jsonrpc: '2.0',
    });
    expect(await mcp.handle({ id: 9, method: 'tools/list' })).toEqual({
      error: { code: -32600, message: 'Invalid JSON-RPC request.' },
      id: 9,
      jsonrpc: '2.0',
    });
  });

  it('uses the newline-delimited stdio protocol without logging non-protocol output', async () => {
    const { mcp } = createServer();
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const serving = serveMcpStdio(mcp, input, output);
    input.end(
      '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"get_status","arguments":{}}}\n',
    );
    await serving;
    expect(JSON.parse(written)).toMatchObject({ id: 10, jsonrpc: '2.0' });
    expect(written).toContain('openrepurpose');
  });
});
