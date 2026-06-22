import {
  createBuilder,
  type BuilderContext,
  type BuilderRun,
} from "@angular-devkit/architect";
import {
  tunnel,
  type Tunnel,
  type TunnelGrant,
} from "@mikkel-ol/yatsi";
import {
  delegateBuilder,
  resolveDevServerPort,
  waitForDevServer,
} from "../shared/architect";
import type { RemoteSchema } from "../shared/schema";

const MAX_REMOTE_ENTRY_BYTES = 1024 * 1024;

interface RegistrationResponse {
  registrationToken: string;
  grant: TunnelGrant;
}

export default createBuilder<RemoteSchema>((options, context) => {
  let run: BuilderRun | undefined;
  let completeSuccessfully: (() => void) | undefined;
  let activeTunnel: Tunnel | undefined;
  let registrationToken: string | undefined;
  const remoteName = validateRemoteName(options.remoteName);
  let remoteEntry = "";
  let closing = false;
  let initialized = false;
  let initializing: Promise<void> | undefined;
  let publicationQueue = Promise.resolve();
  const sessionUrl = new URL(options.sessionUrl);
  const joinToken = requiredJoinToken(sessionUrl);
  sessionUrl.search = "";
  sessionUrl.hash = "";

  const cleanup = async () => {
    if (closing) return;
    closing = true;
    activeTunnel?.close();
    if (registrationToken) {
      await controlRequest(sessionUrl, "/__federation_session/registration", registrationToken, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  };

  context.addTeardown(cleanup);

  return delegateBuilder(
    options.target,
    context,
    async () => {
      if (!initialized) return;
      publicationQueue = publicationQueue.then(async () => {
        if (!registrationToken || !remoteEntry) return;
        try {
          await publishReadyRevision(sessionUrl, registrationToken, remoteEntry);
          context.logger.info(`${remoteName} published from ${remoteEntry}`);
        } catch (error) {
          context.logger.error(
            `Remote revision was not published: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      await publicationQueue;
    },
    (scheduled, complete) => {
      run = scheduled;
      completeSuccessfully = complete;
      initializing ??= initialize();
      void initializing.catch(async (error) => {
        context.logger.error(error instanceof Error ? error.message : String(error));
        await run?.stop();
      });
    },
  );

  async function initialize() {
    context.logger.info("Waiting for the remote Native Federation server");
    const port = await resolveDevServerPort(options.target, context);
    await waitForDevServer(port, "/remoteEntry.json");
    context.logger.info("Remote server ready; registering with the federation session");
    const registration = await controlRequest<RegistrationResponse>(
      sessionUrl,
      "/__federation_session/register",
      joinToken,
      {
        method: "POST",
        body: JSON.stringify({ name: remoteName }),
      },
    );
    registrationToken = registration.registrationToken;
    activeTunnel = await openGrantedTunnel(registration.grant, port, sessionUrl);
    remoteEntry = `${activeTunnel.url}/remoteEntry.json`;
    watchTunnel(activeTunnel);
    void watchSessionEvents();
    await publishReadyRevision(sessionUrl, registrationToken, remoteEntry);
    initialized = true;
    context.logger.info(`${remoteName} published from ${remoteEntry}`);
    void watchFederationBuilds(port);
  }

  async function watchFederationBuilds(port: number) {
    while (!closing) {
      try {
        const response = await fetch(
          `http://localhost:${port}/@angular-architects/native-federation:build-notifications`,
        );
        if (!response.ok || !response.body) throw new Error("Build notification stream unavailable");
        for await (const event of readSse(response.body)) {
          if (event.type !== "federation-rebuild-complete" || !registrationToken || !remoteEntry) {
            continue;
          }
          try {
            await publishReadyRevision(sessionUrl, registrationToken, remoteEntry);
            context.logger.info(`${remoteName} revision published`);
          } catch (error) {
            context.logger.error(
              `Remote revision was not published: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } catch {
        if (!closing) await sleep(500);
      }
    }
  }

  function watchTunnel(current: Tunnel) {
    void current.closed.then(async () => {
      if (closing || activeTunnel !== current || !registrationToken) return;
      const deadline = Date.now() + 30_000;
      let delay = 250;

      while (!closing && Date.now() < deadline) {
        try {
          const response = await controlRequest<{ grant: TunnelGrant }>(
            sessionUrl,
            "/__federation_session/grant",
            registrationToken,
            { method: "POST" },
          );
          const replacement = await openGrantedTunnel(
            response.grant,
            await resolveDevServerPort(options.target, context),
            sessionUrl,
          );
          activeTunnel = replacement;
          remoteEntry = `${replacement.url}/remoteEntry.json`;
          watchTunnel(replacement);
          await publishReadyRevision(sessionUrl, registrationToken, remoteEntry);
          context.logger.info(`${remoteName} tunnel recovered`);
          return;
        } catch {
          await sleep(delay);
          delay = Math.min(delay * 2, 4_000);
        }
      }

      context.logger.error("Remote tunnel could not reconnect within 30 seconds");
      await run?.stop();
    });
  }

  async function watchSessionEvents() {
    if (!registrationToken) return;
    const deadline = () => Date.now() + 30_000;
    let unavailableUntil = deadline();
    let delay = 250;

    while (!closing) {
      try {
        const response = await fetch(new URL("/__federation_session/events", sessionUrl), {
          headers: { Authorization: `Bearer ${registrationToken}` },
        });
        if (!response.ok || !response.body) throw new Error("Federation session event stream unavailable");
        unavailableUntil = deadline();
        delay = 250;

        for await (const event of readSse(response.body)) {
          if (event.type === "session-ended" || event.type === "removed") {
            closing = true;
            context.logger.info(
              event.type === "session-ended" ? "Federation session ended" : "Remote removed by host",
            );
            activeTunnel?.close();
            completeSuccessfully?.();
            return;
          }
        }
        if (!(await hostSessionExists(sessionUrl))) {
          closing = true;
          context.logger.info("Federation session ended");
          activeTunnel?.close();
          completeSuccessfully?.();
          return;
        }
      } catch {
        if (Date.now() >= unavailableUntil) {
          context.logger.error("Federation session unavailable for 30 seconds");
          await run?.stop();
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 4_000);
      }
    }
  }
});

async function hostSessionExists(sessionUrl: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("/__federation_session/session", sessionUrl), {
      redirect: "manual",
    });
    return response.ok;
  } catch {
    return true;
  }
}

async function openGrantedTunnel(
  grant: TunnelGrant,
  port: number,
  sessionUrl: URL,
): Promise<Tunnel> {
  const serverHost = yatsiServerHost(sessionUrl);
  return tunnel.start({
    port,
    token: grant.token,
    domain: serverHost,
    secure: sessionUrl.protocol === "https:",
  });
}

function yatsiServerHost(sessionUrl: URL): string {
  const labels = sessionUrl.hostname.split(".");
  if (labels.length < 2) throw new Error("Federation Session URL does not contain a YATSI subdomain");
  labels.shift();
  return `${labels.join(".")}${sessionUrl.port ? `:${sessionUrl.port}` : ""}`;
}

async function publishReadyRevision(sessionUrl: URL, token: string, remoteEntry: string) {
  const deadline = Date.now() + 10_000;
  let delay = 100;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await fetchRemoteEntry(remoteEntry);
      return await controlRequest(sessionUrl, "/__federation_session/revision", token, {
        method: "POST",
        body: JSON.stringify({ remoteEntry }),
      });
    } catch (error) {
      lastError = error;
      await sleep(delay);
      delay = Math.min(delay * 2, 1_000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Remote entry did not become ready");
}

async function fetchRemoteEntry(remoteEntry: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(remoteEntry, {
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Remote entry returned ${response.status}`);
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Remote entry redirects are not allowed");
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Remote entry must be JSON");
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_REMOTE_ENTRY_BYTES) {
      throw new Error("Remote entry is too large");
    }
    const body = await readLimitedBody(response, MAX_REMOTE_ENTRY_BYTES);
    JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedBody(response: globalThis.Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Remote entry is too large");
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

async function controlRequest<T = unknown>(
  sessionUrl: URL,
  pathName: string,
  token: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(new URL(pathName, sessionUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Federation session request failed with ${response.status}`);
  return body as T;
}

async function* readSse(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) yield JSON.parse(data) as { type?: string };
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredJoinToken(url: URL): string {
  const token = url.searchParams.get("join");
  if (!token) throw new Error("Federation Session URL must contain a join token");
  return token;
}

function validateRemoteName(name: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("remoteName must be lowercase kebab-case");
  }
  return name;
}
