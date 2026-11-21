export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Fired when any API call returns 401, so the app shell can send the user to the sign-in page. */
export const UNAUTHORIZED_EVENT = "nightingale:unauthorized";

/**
 * JSON fetch for the app's own API. Authentication rides the HttpOnly session cookie; the legacy
 * `userId` option is accepted for call-site compatibility but never sent (identity headers are not
 * trusted by the server).
 */
export async function apiFetch<T>(
  path: string,
  options: { userId?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(data.error ?? `Request failed (${response.status})`, response.status, data);
  }
  return data;
}
