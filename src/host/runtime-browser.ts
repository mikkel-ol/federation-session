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

const DEFAULT_STAGE_HEADING = "Federated Session";

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

defineSessionStageElement();
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
const stageGrid = prepareStage(stage);
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
      stageGrid.append(item.slot);
    }
    item.status.textContent = remote.status;
    item.slot.dataset.status = remote.status;
    item.status.dataset.status = remote.status;
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

function defineSessionStageElement() {
  if (customElements.get("federation-session-stage")) return;

  customElements.define(
    "federation-session-stage",
    class extends HTMLElement {
      connectedCallback() {
        this.upgradeProperty("heading");
      }

      get heading() {
        return this.getAttribute("heading") ?? "";
      }

      set heading(value: string) {
        if (value == null) {
          this.removeAttribute("heading");
        } else {
          this.setAttribute("heading", value);
        }
      }

      private upgradeProperty(property: "heading") {
        if (!Object.prototype.hasOwnProperty.call(this, property)) return;
        const value = this[property];
        delete this[property];
        this[property] = value;
      }
    },
  );
}

function prepareStage(stage: HTMLElement) {
  stage.classList.add("federation-session-stage");
  const header = document.createElement("header");
  header.className = "federation-session-stage__header";

  const title = document.createElement("h1");
  title.textContent = stageHeading(stage);

  const eyebrow = document.createElement("span");
  eyebrow.textContent = "Live remotes";

  header.append(title, eyebrow);

  const grid = document.createElement("div");
  grid.className = "federation-session-stage__grid";
  const existingChildren = [...stage.children].filter(
    (child) =>
      !child.classList.contains("federation-session-stage__header") &&
      !child.classList.contains("federation-session-stage__grid"),
  );
  grid.append(...existingChildren);
  stage.replaceChildren(header, grid);
  stage.setAttribute("aria-label", title.textContent);

  const updateTitle = () => {
    title.textContent = stageHeading(stage);
    stage.setAttribute("aria-label", title.textContent);
  };
  new MutationObserver(updateTitle).observe(stage, {
    attributes: true,
    attributeFilter: ["heading"],
  });

  return grid;
}

function stageHeading(stage: HTMLElement) {
  const property = (stage as HTMLElement & { heading?: unknown }).heading;
  const value =
    typeof property === "string" && property.trim()
      ? property
      : stage.getAttribute("heading");
  return value?.trim() || DEFAULT_STAGE_HEADING;
}

function createSlot(remote: RemoteState): MountedRemote {
  const slot = document.createElement("section");
  slot.className = "federation-session-slot";
  const header = document.createElement("header");
  const name = document.createElement("strong");
  name.textContent = remote.name;
  const status = document.createElement("span");
  status.className = "federation-session-status";
  status.dataset.status = remote.status;
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
  root.dataset.open = "false";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "federation-session-panel__toggle";
  toggle.setAttribute("aria-expanded", "false");
  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = "Session";
  const remoteCount = document.createElement("span");
  remoteCount.className = "federation-session-panel__count";
  remoteCount.textContent = "0";
  toggle.append(toggleLabel, remoteCount);

  const panel = document.createElement("div");
  panel.className = "federation-session-panel__popover";
  panel.id = "federation-session-panel-details";
  toggle.setAttribute("aria-controls", panel.id);

  const inviteGroup = document.createElement("div");
  inviteGroup.className = "federation-session-panel__invite";
  const inviteLabel = document.createElement("span");
  inviteLabel.textContent = "Session URL";
  const invite = document.createElement("code");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  inviteGroup.append(inviteLabel, invite, copy);

  const list = document.createElement("div");
  list.className = "federation-session-panel__list";
  panel.append(inviteGroup, list);
  root.append(toggle, panel);
  document.body.append(root);

  let inviteText = "";
  toggle.addEventListener("click", () => {
    const open = root.dataset.open !== "true";
    root.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  copy.addEventListener("click", async () => {
    if (!inviteText || !navigator.clipboard) return;
    await navigator.clipboard.writeText(inviteText);
    copy.textContent = "Copied";
    setTimeout(() => {
      copy.textContent = "Copy";
    }, 1_200);
  });

  return {
    update(session: SessionState) {
      const fullInvite = token
        ? `${session.publicUrl}?join=${encodeURIComponent(token)}`
        : session.publicUrl;
      inviteText = fullInvite;
      invite.textContent = fullInvite;
      remoteCount.textContent = String(session.remotes.length);
      list.replaceChildren(
        ...(session.remotes.length
          ? session.remotes.map((remote) => {
              const row = document.createElement("div");
              row.className = "federation-session-panel__remote";
              const label = document.createElement("span");
              label.textContent = remote.name;
              const status = document.createElement("span");
              status.className = "federation-session-status";
              status.dataset.status = remote.status;
              status.textContent = remote.status;
              row.append(label, status);
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
            })
          : [emptyRemoteList()]),
      );
    },
  };
}

function emptyRemoteList() {
  const empty = document.createElement("p");
  empty.className = "federation-session-panel__empty";
  empty.textContent = "Waiting for remotes";
  return empty;
}

const style = document.createElement("style");
style.textContent = `
federation-session-stage {
  --fs-surface: #ffffff;
  --fs-ink: #172026;
  --fs-muted: #65717a;
  --fs-border: #d9e0e6;
  --fs-accent: #1b6fba;
  --fs-success: #14804a;
  --fs-warn: #a45c00;
  --fs-shadow: 0 18px 55px #1720261c;
  box-sizing: border-box;
  display: block;
  min-height: 100vh;
  padding: clamp(18px, 3vw, 36px);
  background:
    linear-gradient(135deg, #f7fafc 0%, #eef5f9 45%, #f8f3ea 100%);
  color: var(--fs-ink);
  font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
federation-session-stage *, federation-session-stage *::before, federation-session-stage *::after,
.federation-session-panel *, .federation-session-panel *::before, .federation-session-panel *::after {
  box-sizing: border-box;
}
.federation-session-stage__header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  max-width: 1440px;
  margin: 0 auto 18px;
}
.federation-session-stage__header h1 {
  margin: 0;
  font: 700 clamp(24px, 3vw, 38px)/1.05 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0;
}
.federation-session-stage__header span {
  color: var(--fs-muted);
  font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-transform: uppercase;
}
.federation-session-stage__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(14px, 2vw, 22px);
  max-width: 1440px;
  margin: 0 auto;
}
.federation-session-slot {
  display: grid;
  grid-template-rows: auto minmax(220px, 1fr);
  min-width: 0;
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--fs-border);
  border-radius: 8px;
  background: var(--fs-surface);
  box-shadow: var(--fs-shadow);
}
.federation-session-slot>header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--fs-border);
  background: #fbfcfd;
  font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.federation-session-slot strong {
  min-width: 0;
  overflow: hidden;
  color: var(--fs-ink);
  font: 700 14px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.federation-session-status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid #c9d7d0;
  border-radius: 999px;
  background: #eef8f1;
  color: var(--fs-success);
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-transform: uppercase;
}
.federation-session-status::before {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
  content: "";
}
.federation-session-status[data-status="not ready"],
.federation-session-status[data-status="reconnecting"] {
  border-color: #ead5b8;
  background: #fff7eb;
  color: var(--fs-warn);
}
.federation-session-status[data-status="last revision active"] {
  border-color: #c9d5e6;
  background: #eef4fb;
  color: var(--fs-accent);
}
.federation-session-slot[data-status="reconnecting"] {
  opacity: .76;
}
.federation-session-slot> :not(header) {
  display: block;
  min-width: 0;
  padding: 16px;
}
.federation-session-panel {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  width: min(390px, calc(100vw - 36px));
  color: #1c2329;
  font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.federation-session-panel__toggle {
  display: inline-flex;
  float: right;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 0 14px;
  border: 1px solid #0f334d;
  border-radius: 999px;
  background: #172026;
  color: #fff;
  font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  box-shadow: 0 12px 30px #17202633;
  cursor: pointer;
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}
.federation-session-panel__toggle:hover {
  transform: translateY(-1px);
  box-shadow: 0 16px 38px #1720263d;
}
.federation-session-panel__count {
  display: inline-grid;
  min-width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 999px;
  background: #f4c95d;
  color: #172026;
  font-size: 12px;
}
.federation-session-panel__popover {
  clear: both;
  max-height: min(70vh, 560px);
  overflow: auto;
  margin-bottom: 12px;
  padding: 14px;
  border: 1px solid var(--fs-border, #d9e0e6);
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 20px 60px #1720262e;
  opacity: 0;
  pointer-events: none;
  transform: translateY(10px) scale(.98);
  transform-origin: bottom right;
  transition: opacity .18s ease, transform .18s ease;
}
.federation-session-panel[data-open="true"] .federation-session-panel__popover {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0) scale(1);
}
.federation-session-panel__invite {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  margin-bottom: 12px;
}
.federation-session-panel__invite>span {
  grid-column: 1 / -1;
  color: #65717a;
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-transform: uppercase;
}
.federation-session-panel code {
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 9px 10px;
  border: 1px solid #d9e0e6;
  border-radius: 6px;
  background: #f6f8fa;
  color: #172026;
}
.federation-session-panel button {
  font: inherit;
}
.federation-session-panel__invite button,
.federation-session-panel__remote button {
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid #c8d2da;
  border-radius: 6px;
  background: #fff;
  color: #172026;
  cursor: pointer;
}
.federation-session-panel__list {
  display: grid;
  gap: 8px;
}
.federation-session-panel__remote {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid #edf1f4;
  border-radius: 6px;
  background: #fbfcfd;
}
.federation-session-panel__remote>span:first-child {
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.federation-session-panel__empty {
  margin: 0;
  padding: 10px;
  border: 1px dashed #c8d2da;
  border-radius: 6px;
  color: #65717a;
}
@media (max-width: 980px) {
  .federation-session-stage__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 680px) {
  federation-session-stage {
    padding: 14px;
  }
  .federation-session-stage__header {
    display: grid;
    align-items: start;
  }
  .federation-session-stage__grid {
    grid-template-columns: 1fr;
  }
  .federation-session-panel {
    right: 12px;
    bottom: 12px;
    width: min(390px, calc(100vw - 24px));
  }
}
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
