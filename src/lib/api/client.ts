export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  options: { userId: string; method?: string; body?: unknown } = { userId: "" },
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      "x-user-id": options.userId,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? `Request failed (${response.status})`, response.status);
  }
  return data;
}
