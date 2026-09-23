import { describe, expect, it, vi } from 'vitest';
import {
  ObsWebSocketFolderScanTrigger,
  type ObsWebSocketClient,
} from '../../packages/media/src/index.js';

class FakeObsClient implements ObsWebSocketClient {
  public readonly connect = vi.fn(async () => undefined);
  public readonly disconnect = vi.fn(async () => undefined);
  private readonly listeners = new Map<string, (value?: unknown) => void>();

  public on(event: string, listener: (value?: unknown) => void): unknown {
    this.listeners.set(event, listener);
  }

  public emit(event: string, value?: unknown): void {
    this.listeners.get(event)?.(value);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('OBS WebSocket folder scan trigger', () => {
  it('uses output events only as immediate scan hints', async () => {
    const client = new FakeObsClient();
    const onScan = vi.fn(async () => undefined);
    const trigger = new ObsWebSocketFolderScanTrigger({
      createClient: () => client,
      endpoint: new URL('ws://127.0.0.1:4455'),
      onScan,
      password: 'not-for-logs',
      reconnectDelayMs: 1_000,
    });

    trigger.start();
    await flush();
    expect(client.connect).toHaveBeenCalledWith('ws://127.0.0.1:4455/', 'not-for-logs', {
      eventSubscriptions: 64,
    });

    client.emit('RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
    client.emit('RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    client.emit('ReplayBufferSaved');
    await flush();

    expect(onScan).toHaveBeenCalledTimes(2);
    await trigger.stop();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('does not reconnect after an authentication or session-invalidated close', async () => {
    vi.useFakeTimers();
    const client = new FakeObsClient();
    const createClient = vi.fn(() => client);
    const trigger = new ObsWebSocketFolderScanTrigger({
      createClient,
      endpoint: new URL('ws://127.0.0.1:4455'),
      onScan: async () => undefined,
      reconnectDelayMs: 1_000,
    });

    trigger.start();
    await flush();
    client.emit('ConnectionClosed', { code: 4009 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(createClient).toHaveBeenCalledOnce();
    await trigger.stop();
    vi.useRealTimers();
  });

  it('does not retry an authentication failure reported by connect', async () => {
    vi.useFakeTimers();
    const client = new FakeObsClient();
    client.connect.mockRejectedValueOnce({ code: 4009 });
    const createClient = vi.fn(() => client);
    const trigger = new ObsWebSocketFolderScanTrigger({
      createClient,
      endpoint: new URL('ws://127.0.0.1:4455'),
      onScan: async () => undefined,
      reconnectDelayMs: 1_000,
    });

    trigger.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(createClient).toHaveBeenCalledOnce();
    await trigger.stop();
    vi.useRealTimers();
  });
});
