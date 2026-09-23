import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP, type Socket } from 'node:net';
import type { LookupAddress } from 'node:dns';
import {
  WebhookTransportError,
  type WebhookTransport,
  type WebhookTransportRequest,
  type WebhookTransportResult,
  type WebhookUrlPolicy,
} from '@openrepurpose/core';

export interface WebhookDnsResolver {
  lookup(hostname: string): Promise<readonly LookupAddress[]>;
}

const systemResolver: WebhookDnsResolver = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
};

function createForbiddenTargets(): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['100.64.0.0', 10],
    ['169.254.0.0', 16],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    blocked.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of [
    ['::', 96],
    ['::', 128],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['fec0::', 10],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    blocked.addSubnet(network, prefix, 'ipv6');
  blocked.addAddress('100.100.100.200', 'ipv4');
  blocked.addAddress('fd00:ec2::254', 'ipv6');
  return blocked;
}

const forbiddenTargets = createForbiddenTargets();

function bareHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/u, '');
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new WebhookTransportError('WEBHOOK_URL_SCHEME_BLOCKED', false);
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0)
    throw new WebhookTransportError('WEBHOOK_URL_INVALID', false);
}

export function isForbiddenWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return false;
  return forbiddenTargets.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export interface ResolvedWebhookTarget {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves every attempt and rejects the whole DNS answer set if any peer violates the ADR. */
export class WebhookNetworkPolicy implements WebhookUrlPolicy {
  public constructor(private readonly resolver: WebhookDnsResolver = systemResolver) {}

  public async validate(url: URL): Promise<void> {
    await this.resolve(url);
  }

  public async resolve(url: URL): Promise<ResolvedWebhookTarget> {
    assertHttpUrl(url);
    const hostname = bareHostname(url.hostname);
    const literalFamily = isIP(hostname);
    const answers =
      literalFamily === 0
        ? await this.resolver.lookup(hostname)
        : [{ address: hostname, family: literalFamily }];
    if (answers.length === 0) throw new WebhookTransportError('WEBHOOK_DNS_EMPTY', true);
    for (const answer of answers) {
      if ((answer.family !== 4 && answer.family !== 6) || isForbiddenWebhookAddress(answer.address))
        throw new WebhookTransportError('WEBHOOK_TARGET_BLOCKED', false);
    }
    const selected = answers[0]!;
    return { address: selected.address, family: selected.family as 4 | 6 };
  }
}

function retryAfterMillis(value: string | string[] | undefined, now: Date): number | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (header === undefined) return undefined;
  if (/^\d+$/u.test(header)) return Math.min(86_400_000, Number(header) * 1_000);
  const instant = Date.parse(header);
  return Number.isNaN(instant)
    ? undefined
    : Math.min(86_400_000, Math.max(0, instant - now.getTime()));
}

function peerMatches(socket: Socket, target: ResolvedWebhookTarget): boolean {
  if (socket.remoteAddress === undefined || isForbiddenWebhookAddress(socket.remoteAddress))
    return false;
  const allowed = new BlockList();
  allowed.addAddress(target.address, target.family === 4 ? 'ipv4' : 'ipv6');
  const peerFamily = isIP(socket.remoteAddress);
  return (
    peerFamily !== 0 && allowed.check(socket.remoteAddress, peerFamily === 4 ? 'ipv4' : 'ipv6')
  );
}

export interface NodeWebhookTransportOptions {
  readonly connectTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly now?: () => Date;
  readonly timeoutMs: number;
}

/** Redirect-free HTTP transport with per-attempt DNS pinning and connected-peer revalidation. */
export class NodeWebhookTransport implements WebhookTransport {
  private readonly now: () => Date;

  public constructor(
    private readonly policy: WebhookNetworkPolicy,
    private readonly options: NodeWebhookTransportOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async send(url: URL, request: WebhookTransportRequest): Promise<WebhookTransportResult> {
    const target = await this.policy.resolve(url);
    return new Promise<WebhookTransportResult>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        request.signal.removeEventListener('abort', abort);
        action();
      };
      const client = url.protocol === 'https:' ? https : http;
      const outgoing = client.request({
        agent: false,
        headers: {
          ...request.headers,
          'content-length': String(Buffer.byteLength(request.body, 'utf8')),
        },
        hostname: bareHostname(url.hostname),
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        port: url.port.length === 0 ? undefined : Number(url.port),
        protocol: url.protocol,
      });
      const abort = () => outgoing.destroy(new WebhookTransportError('WEBHOOK_CANCELLED', false));
      const overallTimer = setTimeout(
        () => outgoing.destroy(new WebhookTransportError('WEBHOOK_TIMEOUT', true)),
        this.options.timeoutMs,
      );
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      outgoing.once('socket', (socket) => {
        const connectTimer = setTimeout(
          () => outgoing.destroy(new WebhookTransportError('WEBHOOK_CONNECT_TIMEOUT', true)),
          this.options.connectTimeoutMs,
        );
        const connected = () => {
          clearTimeout(connectTimer);
          if (!peerMatches(socket, target))
            outgoing.destroy(new WebhookTransportError('WEBHOOK_PEER_BLOCKED', false));
        };
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
        socket.once('close', () => clearTimeout(connectTimer));
      });
      outgoing.once('response', (response) => {
        let responseBytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > this.options.maxResponseBytes) {
            const error = new WebhookTransportError('WEBHOOK_RESPONSE_TOO_LARGE', false);
            finish(() => reject(error));
            response.destroy(error);
            outgoing.destroy(error);
          }
        });
        response.once('end', () => {
          const statusCode = response.statusCode ?? 0;
          const retryAfterMs = retryAfterMillis(response.headers['retry-after'], this.now());
          finish(() =>
            resolve({
              retryable:
                statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500,
              statusCode,
              ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            }),
          );
        });
      });
      outgoing.once('error', (error) => {
        finish(() =>
          reject(
            error instanceof WebhookTransportError
              ? error
              : new WebhookTransportError('WEBHOOK_NETWORK_ERROR', true),
          ),
        );
      });
      outgoing.end(request.body);
    });
  }
}
