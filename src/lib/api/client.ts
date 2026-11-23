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

/** Fired when an API call returns 401 and the session is confirmed gone, so the shell can send the user to sign in. */
export const UNAUTHORIZED_EVENT = "nightingale:unauthorized";

/**
 * JSON fetch for the app's own API. Authentication rides the HttpOnly session cookie; the legacy
 * `userId` option is accepted for call-site compatibility but never sent (identity headers are not
 * trusted by the server).
 */
/** Endpoints whose 401 is an answer (wrong password, not signed in), not a lost session. */
const AUTH_ANSWER_PATHS = ["/api/auth/login", "/api/auth/me", "/api/auth/register", "/api/auth/activate"];

function send(path: string, options: { method?: string; body?: unknown }): Promise<Response> {
  return fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

/** True when the server confirms there is no valid session (a 401 from /api/auth/me). */
export async function sessionIsGone(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    return response.status === 401;
  } catch {
    // Network trouble is not a sign-out; let the caller show the request's own error.
    return false;
  }
}

export async function apiFetch<T>(
  path: string,
  options: { userId?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  let response = await send(path, options);
  const answersAuth = AUTH_ANSWER_PATHS.some((prefix) => path.startsWith(prefix));
  if (response.status === 401 && !answersAuth && typeof window !== "undefined") {
    // Confirm before signing the user out: if the session is still valid, the 401 was transient
    // (for example a server restart mid-request). requireActor runs before any handler work, so a
    // request refused with 401 changed nothing and can safely be sent once more.
    if (await sessionIsGone()) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    } else {
      response = await send(path, options);
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      }
    }
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? `Request failed (${response.status})`, response.status, data);
  }
  return data;
}
