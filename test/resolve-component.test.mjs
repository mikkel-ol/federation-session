import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolveExposedComponent, isAngularComponent } = await import(
  path.join(root, "dist/host/resolve-component.js")
);

// Stand-in for an Angular component class: the compiler stamps a static `ɵcmp`
// definition onto every @Component-decorated class, which is what the resolver
// keys off of.
function makeComponent(name) {
  const cls = { [name]: class {} }[name];
  cls["ɵcmp"] = { type: cls };
  return cls;
}

test("resolves the modern Angular `App` export from app.ts", () => {
  const App = makeComponent("App");
  assert.equal(resolveExposedComponent({ App }), App);
});

test("resolves the legacy `AppComponent` export from app.component.ts", () => {
  const AppComponent = makeComponent("AppComponent");
  assert.equal(resolveExposedComponent({ AppComponent }), AppComponent);
});

test("resolves a default-exported component", () => {
  const def = makeComponent("Whatever");
  assert.equal(resolveExposedComponent({ default: def }), def);
});

test("resolves a component under an arbitrary export name", () => {
  const Dashboard = makeComponent("DashboardWidget");
  assert.equal(resolveExposedComponent({ Dashboard }), Dashboard);
});

test("prefers a real component when `default` is not a component", () => {
  // e.g. a module whose default export is metadata/routes, with the component
  // exported under a name.
  const App = makeComponent("App");
  const module = { default: { routes: [] }, App };
  assert.equal(resolveExposedComponent(module), App);
});

test("prefers conventional names over an unrelated exported component", () => {
  const AppComponent = makeComponent("AppComponent");
  const Helper = makeComponent("Helper");
  // Object insertion order puts Helper first, but AppComponent must win.
  const module = { Helper, AppComponent };
  assert.equal(resolveExposedComponent(module), AppComponent);
});

test("returns undefined when no export is an Angular component", () => {
  const module = {
    default: { not: "a component" },
    bootstrapApplication: () => {},
    AppConfig: { providers: [] },
  };
  assert.equal(resolveExposedComponent(module), undefined);
});

test("does not treat a plain class without ɵcmp as a component", () => {
  assert.equal(isAngularComponent(class {}), false);
  assert.equal(isAngularComponent(makeComponent("Real")), true);
});
