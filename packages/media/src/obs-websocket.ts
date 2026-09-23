import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';

export interface ObsWebSocketClient {
  connect(
    url: string,
    password: string | undefined,
    options: { readonly eventSubscriptions: EventSubscription },
  ): Promise<unknown>;
  disconnect(): Promise<void>;
  on(event: 'ConnectionClosed', listener: (error: { readonly code: number }) => void): unknown;
  on(
    event: 'RecordStateChanged',
    listener: (event: { readonly outputState: string }) => void,
  ): unknown;
  on(event: 'ReplayBufferSaved', listener: () => void): unknown;
}

export interface ObsWebSocketFolderScanTriggerOptions {
  readonly createClient?: () => ObsWebSocketClient;
  readonly endpoint: URL;
  readonly onConnectionFailure?: () => void;
  readonly onScan: () => Promise<void>;
  readonly password?: string;
  readonly reconnectDelayMs: number;
}

const noReconnectCloseCodes = new Set([4009, 4011]);
const recordingStoppedState = 'OBS_WEBSOCKET_OUTPUT_STOPPED';

function closeCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

/**
 * Optional low-latency folder-watch hint. Periodic scans, settle windows, and durable cursors
 * remain authoritative when OBS is absent, disconnected, or emits duplicate events.
 */
export class ObsWebSocketFolderScanTrigger {
  private client: ObsWebSocketClient | undefined;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private scanInProgress = false;
  private scanRequested = false;
  private stopped = true;

  public constructor(private readonly options: ObsWebSocketFolderScanTriggerOptions) {
    if (options.reconnectDelayMs < 1_000) throw new Error('Invalid OBS WebSocket reconnect delay.');
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.client !== undefined) return;
    this.connecting = true;
    const client = (this.options.createClient ?? (() => new OBSWebSocket()))();
    this.register(client);
    try {
      await client.connect(this.options.endpoint.toString(), this.options.password, {
        eventSubscriptions: EventSubscription.Outputs,
      });
      if (this.stopped) {
        await client.disconnect();
        return;
      }
      this.client = client;
    } catch (error) {
      this.options.onConnectionFailure?.();
      if (!noReconnectCloseCodes.has(closeCode(error) ?? -1)) this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private register(client: ObsWebSocketClient): void {
    client.on('RecordStateChanged', ({ outputState }) => {
      if (outputState === recordingStoppedState) this.requestScan();
    });
    client.on('ReplayBufferSaved', () => this.requestScan());
    client.on('ConnectionClosed', ({ code }) => {
      if (this.client === client) this.client = undefined;
      if (!this.stopped && !noReconnectCloseCodes.has(code)) this.scheduleReconnect();
    });
  }

  private requestScan(): void {
    this.scanRequested = true;
    if (!this.scanInProgress) void this.runRequestedScans();
  }

  private async runRequestedScans(): Promise<void> {
    this.scanInProgress = true;
    try {
      while (this.scanRequested) {
        this.scanRequested = false;
        await this.options.onScan();
      }
    } finally {
      this.scanInProgress = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.options.reconnectDelayMs);
  }
}
