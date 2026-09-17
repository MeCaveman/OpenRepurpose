export const REDACTED_LOG_VALUE = '[REDACTED]';

export type LogLevel = 'debug' | 'error' | 'info' | 'warn';

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface RedactedLogEntry {
  readonly fields: LogFields;
  readonly level: LogLevel;
  readonly message: string;
  readonly subsystem: string;
  readonly timestamp: string;
}

export interface RedactingLoggerOptions {
  readonly now?: () => Date;
  readonly secrets?: readonly string[];
  readonly subsystem: string;
  readonly write: (entry: RedactedLogEntry) => void;
}

export interface StructuredLogger {
  child(bindings: LogFields): StructuredLogger;
  debug(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
}

const sensitiveKeyPattern = /(authorization|cookie|credential|password|secret|token)/i;
const bearerPattern = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const sensitiveParameterPattern =
  /\b(access_token|refresh_token|client_secret|authorization_code|code)=([^&\s]+)/gi;

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value
    .replace(bearerPattern, (_match, scheme: string) => `${scheme} ${REDACTED_LOG_VALUE}`)
    .replace(sensitiveParameterPattern, (_match, name: string) => `${name}=${REDACTED_LOG_VALUE}`);
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join(REDACTED_LOG_VALUE);
  }
  return redacted;
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return '[Binary]';
  if (seen.has(value)) return '[Circular]';
  if (depth >= 12) return '[Truncated]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => redactValue(item, secrets, seen, depth + 1));
    seen.delete(value);
    return result;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const keys =
    value instanceof Error
      ? new Set(['name', 'message', ...Object.keys(source)])
      : Object.keys(source);
  for (const key of keys) {
    if (sensitiveKeyPattern.test(key)) {
      result[key] = REDACTED_LOG_VALUE;
      continue;
    }
    const nested =
      key === 'name' && value instanceof Error
        ? value.name
        : key === 'message' && value instanceof Error
          ? value.message
          : source[key];
    result[key] = redactValue(nested, secrets, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

/** Redacts sensitive keys, auth headers/query values, registered literals, errors, and cycles. */
export function redactLogValue(value: unknown, secrets: readonly string[] = []): unknown {
  return redactValue(value, secrets, new WeakSet<object>(), 0);
}

export function redactLogText(value: string, secrets: readonly string[] = []): string {
  return redactText(value, secrets);
}

export function createRedactingLogger(options: RedactingLoggerOptions): StructuredLogger {
  const now = options.now ?? (() => new Date());
  const create = (bindings: LogFields): StructuredLogger => {
    const log = (level: LogLevel, fields: LogFields, message: string) => {
      const combined = { ...bindings, ...fields };
      const redacted = redactLogValue(combined, options.secrets) as LogFields;
      options.write({
        fields: redacted,
        level,
        message: redactLogText(message, options.secrets),
        subsystem: options.subsystem,
        timestamp: now().toISOString(),
      });
    };
    return {
      child: (childBindings) => create({ ...bindings, ...childBindings }),
      debug: (fields, message) => log('debug', fields, message),
      error: (fields, message) => log('error', fields, message),
      info: (fields, message) => log('info', fields, message),
      warn: (fields, message) => log('warn', fields, message),
    };
  };
  return create({});
}
