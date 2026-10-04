/**
 * Client-input error shared by the central platform building blocks.
 *
 * server.ts maps it to its HTTP status with the message intact, so callers see
 * which field was rejected. Never put provider secrets or payload bodies in it.
 */
export class PlatformInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PlatformInputError';
    this.status = status;
  }
}

export function requireObject(value: unknown, label = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformInputError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new PlatformInputError(`${field} is required`);
  }
  if (value.length > maxLength) {
    throw new PlatformInputError(`${field} must be at most ${maxLength} characters`);
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  if (body[field] === undefined || body[field] === null || body[field] === '') return undefined;
  return requireString(body, field, maxLength);
}
