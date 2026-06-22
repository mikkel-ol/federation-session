import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import express, { type Request, type Response } from "express";
import httpProxy from "http-proxy";
import QRCode from "qrcode";
import { createGrantClient, tunnel, type Tunnel } from "@mikkel-ol/yatsi";
import { runtimeSource } from "./runtime";

const CONTROL_PREFIX = "/__federation_session";
const RECONNECT_MS = 30_000;
const MAX_REMOTE_ENTRY_BYTES = 1024 * 1024;
const REGISTRATION_WINDOW_MS = 60_000;
const MAX_REGISTRATIONS_PER_WINDOW = 60;

interface Registration {
  name: string;
  token: string;
  status: "not ready" | "connected" | "reconnecting" | "last revision active";
  remoteEntry?: string;
  revision: number;
  order: number;
  eventResponses: Set<Response>;
  removalTimer?: NodeJS.Timeout;
}

export interface HostGatewayOptions {
  appPort: number;
  gatewayPort: number;
  capacity: number;
  panel: boolean;
  yatsiServerUrl: string;
  apiKey: string;
}

export interface HostGateway {
  localUrl: string;
  publicUrl: string;
  inviteUrl: string;
  joinToken: string;
  close(): Promise<void>;
}

export async function startHostGateway(options: HostGatewayOptions): Promise<HostGateway> {
  const app = express();
  const proxy = httpProxy.createProxyServer({ ws: true });
  const serverUrl = new URL(options.yatsiServerUrl);
  const joinToken = randomBytes(24).toString("base64url");
  const scope = randomUUID();
  const registrations = new Map<string, Registration>();
  const registrationAttempts = new Map<string, { count: number; startedAt: number }>();
  const grants = createGrantClient({ serverUrl: serverUrl.origin, apiKey: options.apiKey });
  let publicUrl = "";
  let order = 0;
  let closing: Promise<void> | undefined;

  app.use(express.json({ limit: "64kb" }));

  app.get(`${CONTROL_PREFIX}/session`, (_req, res) => {
    res.json({ publicUrl, slug: new URL(publicUrl).hostname.split(".")[0], capacity: options.capacity });
  });

  app.get(`${CONTROL_PREFIX}/state`, (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json({
      publicUrl,
      remotes: [...registrations.values()]
        .filter((registration) => registration.remoteEntry)
        .sort((a, b) => a.order - b.order)
        .map(publicRegistration),
    });
  });

  app.get(`${CONTROL_PREFIX}/invite-qr`, requireJoinToken(joinToken), async (_req, res) => {
    res.type("image/svg+xml").send(await QRCode.toString(`${publicUrl}?join=${joinToken}`, { type: "svg" }));
  });

  app.post(`${CONTROL_PREFIX}/register`, requireJoinToken(joinToken), async (req, res) => {
    if (!allowRegistration(req.ip || req.socket.remoteAddress || "unknown", registrationAttempts)) {
      res.status(429).json({ error: "Too many registration attempts" });
      return;
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
      res.status(400).json({ error: "Remote name must be lowercase kebab-case" });
      return;
    }
    if (registrations.has(name)) {
      res.status(409).json({ error: `Remote name '${name}' is already registered` });
      return;
    }
    if (registrations.size >= options.capacity) {
      res.status(409).json({ error: "Federation session is full" });
      return;
    }

    const registration: Registration = {
      name,
      token: randomBytes(24).toString("base64url"),
      status: "not ready",
      revision: 0,
      order: order++,
      eventResponses: new Set(),
    };
    const grant = await grants.create({ scope, subject: name, expiresInSeconds: 60 });
    registrations.set(name, registration);
    res.status(201).json({ registrationToken: registration.token, grant });
  });

  app.get(`${CONTROL_PREFIX}/events`, (req, res) => {
    const registration = registrationForRequest(req, registrations);
    if (!registration) {
      res.status(401).json({ error: "Invalid registration token" });
      return;
    }

    clearTimeout(registration.removalTimer);
    registration.removalTimer = undefined;
    if (registration.remoteEntry) registration.status = "connected";
    registration.eventResponses.add(res);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    req.on("close", () => {
      registration.eventResponses.delete(res);
      if (registration.eventResponses.size > 0 || !registrations.has(registration.name)) return;
      registration.status = "reconnecting";
      registration.removalTimer = setTimeout(() => {
        void removeRegistration(registration, registrations, grants, scope);
      }, RECONNECT_MS);
    });
  });

  app.post(`${CONTROL_PREFIX}/grant`, async (req, res) => {
    const registration = registrationForRequest(req, registrations);
    if (!registration) {
      res.status(401).json({ error: "Invalid registration token" });
      return;
    }
    const grant = await grants.create({ scope, subject: registration.name, expiresInSeconds: 60 });
    res.json({ grant });
  });

  app.post(`${CONTROL_PREFIX}/revision`, async (req, res) => {
    const registration = registrationForRequest(req, registrations);
    if (!registration) {
      res.status(401).json({ error: "Invalid registration token" });
      return;
    }

    const remoteEntry = typeof req.body?.remoteEntry === "string" ? req.body.remoteEntry : "";
    try {
      await validateRemoteEntry(remoteEntry, registration.name, serverUrl);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Remote entry is not ready" });
      return;
    }

    registration.remoteEntry = remoteEntry;
    registration.revision += 1;
    registration.status = "connected";
    res.json({ revision: registration.revision });
  });

  app.delete(`${CONTROL_PREFIX}/registration`, async (req, res) => {
    const registration = registrationForRequest(req, registrations);
    if (!registration) {
      res.status(401).json({ error: "Invalid registration token" });
      return;
    }
    await removeRegistration(registration, registrations, grants, scope);
    res.status(204).end();
  });

  app.delete(`${CONTROL_PREFIX}/remotes/:name`, requireJoinToken(joinToken), async (req, res) => {
    const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const registration = registrations.get(name);
    if (registration) await removeRegistration(registration, registrations, grants, scope);
    res.status(204).end();
  });

  app.get(`${CONTROL_PREFIX}/runtime.js`, (_req, res) => {
    res.type("text/javascript").send(runtimeSource());
  });

  app.use((req, res) => {
    proxyHttp(options.appPort, options.panel, req, res);
  });

  const server = await listen(app, options.gatewayPort);
  server.on("upgrade", (req, socket, head) => {
    proxy.ws(req, socket, head, { target: `http://localhost:${options.appPort}` });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Host gateway did not bind a TCP port");
  const localUrl = `http://localhost:${address.port}`;

  const activeTunnel = await tunnel.start({
    port: address.port,
    token: options.apiKey,
    domain: serverUrl.host,
    secure: serverUrl.protocol === "https:",
  });
  publicUrl = activeTunnel.url;

  return {
    localUrl,
    publicUrl,
    inviteUrl: `${publicUrl}?join=${joinToken}`,
    joinToken,
    close() {
      closing ??= (async () => {
        for (const registration of registrations.values()) {
          sendEvent(registration, { type: "session-ended" });
          registration.eventResponses.forEach((response) => response.end());
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await grants.revoke({ scope });
        } finally {
          activeTunnel.close();
          await closeServer(server);
        }
      })();
      return closing;
    },
  };
}

function publicRegistration(registration: Registration) {
  return {
    name: registration.name,
    status: registration.status,
    remoteEntry: registration.remoteEntry,
    revision: registration.revision,
  };
}

function registrationForRequest(
  req: Request,
  registrations: Map<string, Registration>,
): Registration | undefined {
  const token = bearerToken(req);
  return [...registrations.values()].find((registration) => registration.token === token);
}

function requireJoinToken(joinToken: string) {
  return (req: Request, res: Response, next: () => void) => {
    if (bearerToken(req) !== joinToken) {
      res.status(401).json({ error: "Invalid join token" });
      return;
    }
    next();
  };
}

function bearerToken(req: Request): string | undefined {
  return req.header("authorization")?.replace(/^Bearer\s+/i, "");
}

async function removeRegistration(
  registration: Registration,
  registrations: Map<string, Registration>,
  grants: ReturnType<typeof createGrantClient>,
  scope: string,
) {
  registrations.delete(registration.name);
  clearTimeout(registration.removalTimer);
  sendEvent(registration, { type: "removed" });
  registration.eventResponses.forEach((response) => response.end());
  await grants.revoke({ scope, subject: registration.name });
}

function sendEvent(registration: Registration, event: unknown) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  registration.eventResponses.forEach((response) => response.write(payload));
}

async function validateRemoteEntry(remoteEntry: string, name: string, yatsiServer: URL) {
  const url = new URL(remoteEntry);
  const validHost =
    url.hostname === yatsiServer.hostname || url.hostname.endsWith(`.${yatsiServer.hostname}`);
  if (
    !validHost ||
    url.protocol !== yatsiServer.protocol ||
    effectivePort(url) !== effectivePort(yatsiServer)
  ) {
    throw new Error("Remote entry must use the federation session's YATSI server");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    if (!response.ok) throw new Error(`Remote entry returned ${response.status}`);
    if (response.status >= 300 && response.status < 400) throw new Error("Remote entry redirects are not allowed");
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Remote entry must be JSON");
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_REMOTE_ENTRY_BYTES) throw new Error("Remote entry is too large");
    const body = await readLimitedBody(response, MAX_REMOTE_ENTRY_BYTES);
    const manifest = JSON.parse(body) as { name?: string; exposes?: Array<{ key?: string }> };
    if (manifest.name !== name) throw new Error("Remote entry name does not match registration");
    if (!manifest.exposes?.some((exposure) => exposure.key === "./Component")) {
      throw new Error("Remote entry does not expose ./Component");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedBody(response: globalThis.Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Remote entry is too large");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function allowRegistration(
  address: string,
  attempts: Map<string, { count: number; startedAt: number }>,
): boolean {
  const now = Date.now();
  const current = attempts.get(address);
  if (!current || now - current.startedAt >= REGISTRATION_WINDOW_MS) {
    attempts.set(address, { count: 1, startedAt: now });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_REGISTRATIONS_PER_WINDOW;
}

function effectivePort(url: URL) {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function proxyHttp(port: number, panel: boolean, req: Request, res: Response) {
  const upstream = httpRequest(
    {
      hostname: "localhost",
      port,
      path: req.originalUrl,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${port}` },
    },
    (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers["content-type"] || "");
      if (!contentType.includes("text/html")) {
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const html = Buffer.concat(chunks)
          .toString()
          .replace(
            "</body>",
            `<script type="module-shim" src="${CONTROL_PREFIX}/runtime.js?panel=${panel}"></script></body>`,
          );
        const headers = { ...upstreamResponse.headers };
        delete headers["content-length"];
        res.writeHead(upstreamResponse.statusCode || 200, headers);
        res.end(html);
      });
    },
  );
  upstream.on("error", () => res.status(502).send("Host dev server is unavailable"));
  req.pipe(upstream);
}

function listen(app: express.Express, port: number): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
