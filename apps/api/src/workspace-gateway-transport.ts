import type WebSocket from 'ws';

export const WS_BROWSER_BUFFERED_HIGH_WATER_BYTES = 8 * 1024 * 1024;
export const WS_BROWSER_BACKPRESSURE_TIMEOUT_MS = 30_000;
export const WS_BROWSER_PENDING_MAX_ITEMS = 256;
export const WS_BROWSER_PENDING_MAX_BYTES = 12 * 1024 * 1024;
export const WS_REDIS_INPUT_MAX_BYTES = 16 * 1024 * 1024;
export const WS_MACHINE_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

export class BrowserPendingBudget {
  private items = 0;
  private bytes = 0;

  tryAcquire(size: number): boolean {
    if (!Number.isSafeInteger(size) || size < 0) return false;
    if (this.items + 1 > WS_BROWSER_PENDING_MAX_ITEMS) return false;
    if (this.bytes + size > WS_BROWSER_PENDING_MAX_BYTES) return false;
    this.items += 1;
    this.bytes += size;
    return true;
  }

  release(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) return;
    this.items = Math.max(0, this.items - 1);
    this.bytes = Math.max(0, this.bytes - size);
  }

  snapshot(): {items: number; bytes: number} {
    return {items: this.items, bytes: this.bytes};
  }
}

export function websocketDataToBuffer(data: WebSocket.Data): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError('workspace_websocket_unsupported_data_type');
}

export function isStrictBase64Payload(
  value: unknown,
  maxEncodedBytes: number,
  maxDecodedBytes: number,
): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > maxEncodedBytes || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.byteLength(value, 'base64') <= maxDecodedBytes;
}

export function rewriteWorkspaceLocation(value: string, sessionId: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return value;
  const prefix = `/workspace-gateway/${sessionId}`;
  if (value === prefix || value.startsWith(`${prefix}/`)) return value;
  return `${prefix}${value}`;
}
