import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { authenticate } from "../src/middleware/authenticate.js";

async function authenticateResponse(status: number) {
  const oldUrl = process.env.ACCOUNTS_API_URL;
  const oldFetch = globalThis.fetch;
  process.env.ACCOUNTS_API_URL = "https://accounts.example.test";
  globalThis.fetch = async () => new Response(null, { status });
  try {
    let error: (Error & { status?: number }) | undefined;
    await authenticate(
      { headers: { authorization: "Bearer test-token" } } as Request,
      {} as Response,
      (err?: unknown) => { error = err as Error & { status?: number }; },
    );
    return error;
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.ACCOUNTS_API_URL;
    else process.env.ACCOUNTS_API_URL = oldUrl;
  }
}

test("Account verification 401 remains an expired-session response", async () => {
  const error = await authenticateResponse(401);
  assert.equal(error?.status, 401);
  assert.equal(error?.message, "Invalid or expired session");
});

test("Account verification outages are not reported as expired player sessions", async () => {
  for (const status of [403, 429, 500, 503]) {
    const error = await authenticateResponse(status);
    assert.equal(error?.status, 503, `upstream HTTP ${status}`);
    assert.equal(error?.message, "Account service unavailable");
  }
});
