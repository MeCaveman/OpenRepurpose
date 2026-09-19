export async function getCsrfToken(): Promise<string> {
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('The local session could not be created.');
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}
