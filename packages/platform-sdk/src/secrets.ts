export type SecretScope = 'account' | 'application';

/** A safe-to-log locator. Secret values must never be embedded in references. */
export interface SecretReference {
  readonly name: string;
  readonly ownerId: string;
  readonly scope: SecretScope;
}

/** Server-side credential boundary. Browser-facing code receives status, never this interface. */
export interface SecretStore {
  delete(reference: SecretReference): Promise<boolean>;
  get(reference: SecretReference): Promise<string | undefined>;
  set(reference: SecretReference, value: string): Promise<void>;
}

export function secretReferenceKey(reference: SecretReference): string {
  return JSON.stringify([reference.scope, reference.ownerId, reference.name]);
}
