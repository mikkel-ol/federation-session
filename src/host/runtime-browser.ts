import { resolveExposedComponent } from "./resolve-component.js";

interface RemoteState {
  name: string;
  status: string;
  remoteEntry?: string;
  revision: number;
}

interface SessionState {
  publicUrl: string;
  remotes: RemoteState[];
}

interface RemoteManifest {
  exposes?: Array<{
    key?: string;
    outFileName?: string;
  }>;
}

interface MountedRemote {
  slot: HTMLElement;
  element: HTMLElement;
  status: HTMLElement;
  revision: number;
  componentRef?: {
    hostView: unknown;
    destroy(): void;
  };
}

const pageUrl = new URL(location.href);
const hashParams = new URLSearchParams(pageUrl.hash.slice(1));
const token = pageUrl.searchParams.get("join") ?? hashParams.get("join");
if (token) {
  pageUrl.searchParams.delete("join");
  hashParams.delete("join");
  pageUrl.hash = hashParams.size ? `#${hashParams}` : "";
  history.replaceState(
    null,
    "",
    `${pageUrl.pathname}${pageUrl.search}${pageUrl.hash}`,
  );
}

await waitForHostBootstrap();

const [{ createApplication }, { createComponent }] = await Promise.all([
  import("@angular/platform-browser"),
  import("@angular/core"),
]);

const state = new Map<string, MountedRemote>();
const app = await createApplication({ providers: [] });
const panelEnabled =
  new URL(import.meta.url).searchParams.get("panel") !== "false";
const stage =
  document.querySelector<HTMLElement>("federation-session-stage") ?? createDefaultStage();
const panel = panelEnabled ? createPanel() : { update: (_session: SessionState) => undefined };

async function refresh() {
  const response = await fetch("/__federation_session/state", { cache: "no-store" });
  if (!response.ok) return;
  const session = (await response.json()) as SessionState;
  panel.update(session);

  for (const remote of session.remotes) {
    let item = state.get(remote.name);
    if (!item) {
      item = createSlot(remote);
      state.set(remote.name, item);
      stage.append(item.slot);
    }
    item.status.textContent = remote.status;
    item.slot.dataset.status = remote.status;
    if (remote.remoteEntry && item.revision !== remote.revision) {
      await mountRevision(item, remote);
    }
  }

  for (const [name, item] of state) {
    if (!session.remotes.some((remote) => remote.name === name)) {
      item.componentRef?.destroy();
      item.slot.remove();
      state.delete(name);
    }
  }
}

function createDefaultStage() {
  const element = document.createElement("federation-session-stage");
  element.dataset.default = "true";
  document.body.append(element);
  return element;
}

function createSlot(remote: RemoteState): MountedRemote {
  const slot = document.createElement("section");
  slot.className = "federation-session-slot";
  const header = document.createElement("header");
  const name = document.createElement("strong");
  name.textContent = remote.name;
  const status = document.createElement("span");
  header.append(name, status);

  const elementName = `federation-remote-${remote.name}`;
  if (!customElements.get(elementName)) {
    customElements.define(elementName, class extends HTMLElement {});
  }
  const element = document.createElement(elementName);
  slot.append(header, element);
  return { slot, element, status, revision: 0 };
}

async function mountRevision(item: MountedRemote, remote: RemoteState) {
  try {
    const entry = new URL(remote.remoteEntry!);
    entry.searchParams.set("revision", String(remote.revision));
    const response = await fetch(entry);
    if (!response.ok) {
      throw new Error(`Remote entry returned ${response.status}`);
    }
    const manifest = (await response.json()) as RemoteManifest;
    const exposure = manifest.exposes?.find(
      (candidate) => candidate.key === "./Component",
    );
    if (!exposure?.outFileName) {
      throw new Error("Remote entry does not expose ./Component");
    }
    const componentUrl = new URL(exposure.outFileName, entry);
    componentUrl.searchParams.set("revision", String(remote.revision));
    const module = await importShim(componentUrl.href);
    const component = resolveExposedComponent(module);
    if (!component) {
      throw new Error(
        "./Component does not export an Angular component (looked for a default export, AppComponent, App, or any exported @Component class)",
      );
    }

    const next = document.createElement("div");
    const componentRef = createComponent(component, {
      environmentInjector: app.injector,
      hostElement: next,
    });
    app.attachView(componentRef.hostView);
    item.element.replaceChildren(next);
    item.componentRef?.destroy();
    item.componentRef = componentRef;
    item.revision = remote.revision;
    item.status.textContent = "connected";
  } catch (error) {
    item.status.textContent = item.revision ? "last revision active" : "not ready";
    console.error("Failed to load remote", remote.name, error);
  }
}

declare function importShim(
  specifier: string,
): Promise<Record<string, unknown>>;

function createPanel() {
  const root = document.createElement("aside");
  root.className = "federation-session-panel";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = "Session";
  const panel = document.createElement("div");
  panel.hidden = true;
  const invite = document.createElement("code");
  const list = document.createElement("div");
  panel.append(invite, list);
  root.append(toggle, panel);
  document.body.append(root);
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });

  return {
    update(session: SessionState) {
      const fullInvite = token
        ? `${session.publicUrl}?join=${encodeURIComponent(token)}`
        : session.publicUrl;
      invite.textContent = fullInvite;
      list.replaceChildren(
        ...session.remotes.map((remote) => {
          const row = document.createElement("div");
          const label = document.createElement("span");
          label.textContent = `${remote.name} - ${remote.status}`;
          row.append(label);
          if (token) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "Remove";
            remove.addEventListener("click", () => {
              void fetch(
                `/__federation_session/remotes/${encodeURIComponent(remote.name)}`,
                {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${token}` },
                },
              );
            });
            row.append(remove);
          }
          return row;
        }),
      );
    },
  };
}

const style = document.createElement("style");
style.textContent = `
federation-session-stage[data-default="true"] { display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;padding:12px;min-height:60vh }
.federation-session-slot { min-width:0;border:1px solid #c9ced6;background:#fff }
.federation-session-slot>header { display:flex;justify-content:space-between;padding:6px 10px;background:#f2f4f7;font:13px system-ui }
.federation-session-slot[data-status="reconnecting"] { opacity:.72 }
.federation-session-slot> :not(header) { display:block;padding:12px }
.federation-session-panel { position:fixed;right:12px;bottom:12px;z-index:2147483647;font:13px system-ui;color:#17191c }
.federation-session-panel>button { float:right }
.federation-session-panel>div { clear:both;width:min(360px,calc(100vw - 24px));max-height:70vh;overflow:auto;background:#fff;border:1px solid #aeb4bd;padding:12px;box-shadow:0 8px 30px #0002 }
.federation-session-panel code { display:block;overflow-wrap:anywhere;margin-bottom:8px }
.federation-session-panel div div { display:flex;justify-content:space-between;gap:8px;padding:4px 0 }
`;
document.head.append(style);

async function waitForHostBootstrap() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (document.querySelector("app-root")?.childNodes.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await refresh();
setInterval(() => void refresh(), 1_000);
