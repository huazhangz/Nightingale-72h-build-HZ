// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, UNAUTHORIZED_EVENT } from "../src/lib/api/client";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(responses: Record<string, Response[]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      calls.push(input);
      const queue = responses[input];
      const next = queue?.shift();
      if (!next) throw new Error(`unexpected fetch ${input}`);
      return next;
    }),
  );
  return calls;
}

describe("apiFetch and lost sessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once, without signing out, when a 401 is not confirmed by /api/auth/me", async () => {
    const calls = mockFetch({ "/api/patients": [json(401, { error: "Authentication required" }), json(200, { patients: [] })], "/api/auth/me": [json(200, { user: {} })] });
    const signedOut = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    await expect(apiFetch("/api/patients")).resolves.toEqual({ patients: [] });
    expect(calls).toEqual(["/api/patients", "/api/auth/me", "/api/patients"]);
    expect(signedOut).not.toHaveBeenCalled();
    window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  });

  it("signs out once the session is confirmed gone", async () => {
    mockFetch({ "/api/patients": [json(401, { error: "Authentication required" })], "/api/auth/me": [json(401, {})] });
    const signedOut = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    await expect(apiFetch("/api/patients")).rejects.toBeInstanceOf(ApiError);
    expect(signedOut).toHaveBeenCalledTimes(1);
    window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  });

  it("treats a wrong password as an answer, not a lost session", async () => {
    const calls = mockFetch({ "/api/auth/login": [json(401, { error: "Incorrect email or password." })] });
    const signedOut = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    await expect(apiFetch("/api/auth/login", { method: "POST", body: {} })).rejects.toThrow("Incorrect email or password.");
    expect(calls).toEqual(["/api/auth/login"]);
    expect(signedOut).not.toHaveBeenCalled();
    window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  });
});
