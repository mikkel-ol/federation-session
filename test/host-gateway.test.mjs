import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createHostControlApp } = await import(path.join(root, "dist/host/gateway.js"));

test("re-registers a remote name while the previous registration is reconnecting", async () => {
  const registrations = new Map();
  const revoked = [];
  const server = await listen(
    createHostControlApp({
      appPort: 0,
      capacity: 1,
      panel: true,
      serverUrl: new URL("https://session.example.test"),
      joinToken: "join-token",
      scope: "test-scope",
      registrations,
      registrationAttempts: new Map(),
      grants: {
        async create() {
          return { token: "grant-token", url: "https://demo.session.example.test" };
        },
        async revoke(request) {
          revoked.push(request);
        },
      },
      publicUrl: () => "https://host.session.example.test",
      nextOrder: nextOrder(),
    }),
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const first = await register(baseUrl, "demo");
    assert.equal(first.status, 201);
    const { registrationToken: firstToken } = await first.json();

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/__federation_session/events`, {
      headers: { Authorization: `Bearer ${firstToken}` },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    controller.abort();
    await waitFor(() => registrations.get("demo")?.status === "reconnecting");

    const second = await register(baseUrl, "demo");
    assert.equal(second.status, 201);
    const { registrationToken: secondToken } = await second.json();

    assert.notEqual(secondToken, firstToken);
    assert.equal(registrations.get("demo")?.token, secondToken);
    assert.deepEqual(revoked, [{ scope: "test-scope", subject: "demo" }]);
  } finally {
    await close(server);
  }
});

test("rejects a duplicate remote name while the existing registration is active", async () => {
  const server = await listen(
    createHostControlApp({
      appPort: 0,
      capacity: 1,
      panel: true,
      serverUrl: new URL("https://session.example.test"),
      joinToken: "join-token",
      scope: "test-scope",
      registrations: new Map(),
      registrationAttempts: new Map(),
      grants: {
        async create() {
          return { token: "grant-token", url: "https://demo.session.example.test" };
        },
        async revoke() {},
      },
      publicUrl: () => "https://host.session.example.test",
      nextOrder: nextOrder(),
    }),
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await register(baseUrl, "demo")).status, 201);

    const duplicate = await register(baseUrl, "demo");
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      error: "Remote name 'demo' is already registered",
    });
  } finally {
    await close(server);
  }
});

function register(baseUrl, name) {
  return fetch(`${baseUrl}/__federation_session/register`, {
    method: "POST",
    headers: {
      Authorization: "Bearer join-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
}

function nextOrder() {
  let order = 0;
  return () => order++;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.equal(predicate(), true);
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}
