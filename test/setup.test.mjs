import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostTree } from "@angular-devkit/schematics";
import { SchematicTestRunner } from "@angular-devkit/schematics/testing/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = () =>
  new SchematicTestRunner(
    "@mikkel-ol/federation-session",
    path.join(root, "collection.json"),
  );

test("declares project as an optional named setup option", () => {
  const schema = JSON.parse(
    readFileSync(path.join(root, "src/setup/schema.json"), "utf8"),
  );

  assert.equal(schema.properties.project.$default, undefined);
  assert.deepEqual(schema.required, ["role"]);
});

test("infers and configures the only Native Federation host idempotently", async () => {
  const tree = angularFixture({ nativeFederation: true });
  const options = {
    role: "host",
    yatsiServerUrl: "https://tunnel.example.com",
    skipInstall: true,
  };
  const first = await runner().runSchematic("setup", options, tree);
  const second = await runner().runSchematic("setup", options, first);
  const workspace = json(second, "angular.json");
  const project = workspace.projects.demo;

  assert.equal(
    project.architect.serve.builder,
    "@mikkel-ol/federation-session:host",
  );
  assert.equal(project.architect.serve.options.target, "demo:serve-federation");
  assert.equal(
    project.architect["serve-federation"].builder,
    "@angular-architects/native-federation:build",
  );
  const html = text(second, "src/app/app.component.html");
  assert.match(html, /<federation-session-stage><\/federation-session-stage>/);
  assert.equal(html.match(/federation-session-stage/g).length, 2);
  // The original front page is replaced and preserved as a comment.
  assert.match(html, /<!--[\s\S]*<h1>Demo<\/h1>[\s\S]*-->/);
  assert.doesNotMatch(html, /^\s*<h1>Demo<\/h1>/);
  assert.match(
    text(second, "src/app/app.component.ts"),
    /CUSTOM_ELEMENTS_SCHEMA/,
  );
});

test("infers and configures the only Native Federation Nx remote", async () => {
  const tree = nxFixture();
  const result = await runner().runSchematic(
    "setup",
    {
      role: "remote",
      remoteName: "demo-remote",
      skipInstall: true,
    },
    tree,
  );
  const project = json(result, "apps/demo/project.json");

  assert.equal(
    project.targets.serve.executor,
    "@mikkel-ol/federation-session:remote",
  );
  assert.deepEqual(project.targets.serve.options, {
    target: "demo:serve-federation",
    remoteName: "demo-remote",
  });
  assert.equal(
    project.targets["serve-federation"].executor,
    "@angular-architects/native-federation:build",
  );
  assert.match(
    text(result, "apps/demo/federation.config.mjs"),
    /"\.\/Component"/,
  );
  assert.equal(result.exists("workspace.json"), false);
});

test("rejects role conversion without modifying the tree", async () => {
  const tree = angularFixture({ nativeFederation: true });
  const configured = await runner().runSchematic(
    "setup",
    {
      project: "demo",
      role: "host",
      yatsiServerUrl: "https://tunnel.example.com",
      skipInstall: true,
    },
    tree,
  );
  const before = configured.files.map((file) => [file, text(configured, file)]);

  await assert.rejects(
    runner().runSchematic(
      "setup",
      {
        project: "demo",
        role: "remote",
        skipInstall: true,
      },
      configured,
    ),
    /cannot be converted/,
  );
  assert.deepEqual(
    configured.files.map((file) => [file, text(configured, file)]),
    before,
  );
});

test("invokes the real Native Federation generator for a plain Angular app", async () => {
  const tree = angularFixture({ nativeFederation: false });
  const result = await runner().runSchematic(
    "setup",
    {
      project: "demo",
      role: "remote",
      remoteName: "demo",
      port: 4300,
      skipInstall: true,
    },
    tree,
  );
  const workspace = json(result, "angular.json");

  assert.equal(
    workspace.projects.demo.architect.build.builder,
    "@angular-architects/native-federation:build",
  );
  assert.equal(
    workspace.projects.demo.architect.serve.builder,
    "@mikkel-ol/federation-session:remote",
  );
  assert.equal(result.exists("federation.config.mjs"), true);
});

test("adapts a plain Nx project around the real Native Federation generator", async () => {
  const tree = commonFiles("apps/demo/", false);
  tree.create(
    "apps/demo/project.json",
    JSON.stringify(
      {
        name: "demo",
        root: "apps/demo",
        sourceRoot: "apps/demo/src",
        projectType: "application",
        targets: targets(false, true),
      },
      null,
      2,
    ),
  );
  const result = await runner().runSchematic(
    "setup",
    {
      project: "demo",
      role: "remote",
      remoteName: "demo",
      port: 4301,
      skipInstall: true,
    },
    tree,
  );
  const project = json(result, "apps/demo/project.json");

  assert.equal(
    project.targets.build.executor,
    "@angular-architects/native-federation:build",
  );
  assert.equal(
    project.targets.serve.executor,
    "@mikkel-ol/federation-session:remote",
  );
  assert.equal(result.exists("workspace.json"), false);
  assert.equal(result.exists("apps/demo/federation.config.mjs"), true);
});

function angularFixture({ nativeFederation }) {
  const tree = commonFiles("", nativeFederation);
  tree.create(
    "angular.json",
    JSON.stringify(
      {
        version: 1,
        projects: {
          demo: {
            root: "",
            sourceRoot: "src",
            projectType: "application",
            architect: targets(nativeFederation, false),
          },
        },
      },
      null,
      2,
    ),
  );
  return tree;
}

function nxFixture() {
  const tree = commonFiles("apps/demo/", true);
  tree.create(
    "apps/demo/project.json",
    JSON.stringify(
      {
        name: "demo",
        root: "apps/demo",
        sourceRoot: "apps/demo/src",
        projectType: "application",
        targets: targets(true, true),
      },
      null,
      2,
    ),
  );
  return tree;
}

function commonFiles(prefix, nativeFederation) {
  const tree = new HostTree();
  tree.create("package.json", JSON.stringify({ devDependencies: {} }, null, 2));
  tree.create(
    `${prefix}src/main.ts`,
    `import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
bootstrapApplication(AppComponent);
`,
  );
  tree.create(
    `${prefix}src/app/app.component.ts`,
    `import { Component } from "@angular/core";
@Component({
  selector: "app-root",
  templateUrl: "./app.component.html"
})
export class AppComponent {}
`,
  );
  tree.create(`${prefix}src/app/app.component.html`, "<h1>Demo</h1>\n");
  tree.create(`${prefix}src/polyfills.ts`, "");
  if (nativeFederation) {
    tree.create(
      `${prefix}federation.config.mjs`,
      `import { withNativeFederation } from "@angular-architects/native-federation/config";
export default withNativeFederation({
  name: "demo"
});
`,
    );
  }
  return tree;
}

function targets(nativeFederation, nx) {
  const key = nx ? "executor" : "builder";
  if (nativeFederation) {
    return {
      build: {
        [key]: "@angular-architects/native-federation:build",
        configurations: {
          development: { target: "demo:esbuild:development", dev: true },
        },
      },
      serve: {
        [key]: "@angular-architects/native-federation:build",
        options: {
          target: "demo:serve-original:development",
          dev: true,
          watch: true,
        },
      },
      esbuild: {
        [key]: "@angular/build:application",
        options: {
          browser: nx ? "apps/demo/src/main.ts" : "src/main.ts",
          polyfills: nx ? ["apps/demo/src/polyfills.ts"] : ["src/polyfills.ts"],
        },
      },
      "serve-original": {
        [key]: "@angular/build:dev-server",
        configurations: {
          development: { buildTarget: "demo:esbuild:development" },
        },
        options: { port: 4200 },
      },
    };
  }
  return {
    build: {
      [key]: "@angular/build:application",
      options: {
        browser: nx ? "apps/demo/src/main.ts" : "src/main.ts",
        polyfills: nx ? ["apps/demo/src/polyfills.ts"] : ["src/polyfills.ts"],
      },
      configurations: {
        production: {},
        development: {},
      },
    },
    serve: {
      [key]: "@angular/build:dev-server",
      configurations: {
        production: { buildTarget: "demo:build:production" },
        development: { buildTarget: "demo:build:development" },
      },
      defaultConfiguration: "development",
    },
  };
}

function text(tree, filePath) {
  const data = tree.read(filePath);
  assert.ok(data, `Expected ${filePath}`);
  return data.toString("utf8");
}

function json(tree, filePath) {
  return JSON.parse(text(tree, filePath));
}
