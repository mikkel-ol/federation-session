import {
  chain,
  externalSchematic,
  type Rule,
  type SchematicContext,
  type Tree,
} from "@angular-devkit/schematics";
import { NodePackageInstallTask } from "@angular-devkit/schematics/tasks";
import path from "node:path";
import ts from "typescript";

interface SetupOptions {
  project: string;
  role: "host" | "remote";
  yatsiServerUrl?: string;
  remoteName?: string;
  component?: string;
  port?: number;
  capacity?: number;
  skipInstall?: boolean;
}

interface Target {
  builder?: string;
  executor?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, unknown>;
  defaultConfiguration?: string;
}

interface Project {
  root?: string;
  sourceRoot?: string;
  architect?: Record<string, Target>;
  targets?: Record<string, Target>;
  [key: string]: unknown;
}

interface WorkspaceLocation {
  kind: "angular" | "nx";
  path: string;
  workspacePath?: string;
}

export default function setup(options: SetupOptions): Rule {
  validateOptions(options);
  const state: {
    location?: WorkspaceLocation;
    needsNativeFederation?: boolean;
  } = {};

  return chain([
    (tree) => {
      state.location = locateProject(tree, options.project);
      const project = readProject(tree, state.location, options.project);
      assertRoleIsCompatible(project, options.role);
      assertStandalone(tree, project, options.component);
      state.needsNativeFederation = !isNativeFederationProject(tree, project);
      if (state.needsNativeFederation && state.location.kind === "nx") {
        createNxWorkspaceAdapter(tree, state.location, options.project, project);
      }
      return tree;
    },
    (tree, context) => {
      updateDependencies(tree);
      if (!options.skipInstall) context.addTask(new NodePackageInstallTask());
      return tree;
    },
    (tree, context) =>
      state.needsNativeFederation
        ? externalSchematic("@angular-architects/native-federation", "init", {
            project: options.project,
            port: options.port ?? 4200,
            type: options.role,
          })(tree, context)
        : tree,
    (tree) => {
      if (!state.location) throw new Error("Workspace location was not resolved");
      if (state.needsNativeFederation && state.location.kind === "nx") {
        restoreNxWorkspace(tree, state.location, options.project);
      }
      configureProject(tree, state.location, options);
      return tree;
    },
  ]);
}

function validateOptions(options: SetupOptions) {
  if (options.role === "host" && !options.yatsiServerUrl) {
    throw new Error("yatsiServerUrl is required when role is host");
  }
  const remoteName = options.remoteName ?? options.project;
  if (options.role === "remote" && !isRemoteName(remoteName)) {
    throw new Error("remoteName must be lowercase kebab-case");
  }
}

function locateProject(tree: Tree, projectName: string): WorkspaceLocation {
  for (const workspacePath of ["angular.json", "workspace.json"]) {
    if (!tree.exists(workspacePath)) continue;
    const workspace = readJson(tree, workspacePath);
    if (workspace.projects?.[projectName]) {
      return { kind: "angular", path: workspacePath };
    }
  }

  let result: WorkspaceLocation | undefined;
  tree.visit((filePath) => {
    if (result || !filePath.endsWith("/project.json")) return;
    const project = readJson(tree, filePath);
    if (project.name === projectName) {
      result = { kind: "nx", path: trimLeadingSlash(filePath) };
    }
  });
  if (!result) throw new Error(`Project '${projectName}' was not found`);
  return result;
}

function readProject(
  tree: Tree,
  location: WorkspaceLocation,
  projectName: string,
): Project {
  if (location.kind === "nx") return readJson(tree, location.path) as Project;
  return readJson(tree, location.path).projects[projectName] as Project;
}

function writeProject(
  tree: Tree,
  location: WorkspaceLocation,
  projectName: string,
  project: Project,
) {
  if (location.kind === "nx") {
    writeJson(tree, location.path, project);
    return;
  }
  const workspace = readJson(tree, location.path);
  workspace.projects[projectName] = project;
  writeJson(tree, location.path, workspace);
}

function targetsOf(project: Project): Record<string, Target> {
  const targets = project.architect ?? project.targets;
  if (!targets) throw new Error("The project does not define Angular targets");
  return targets;
}

function executorOf(target: Target | undefined): string | undefined {
  return target?.builder ?? target?.executor;
}

function assertRoleIsCompatible(project: Project, role: SetupOptions["role"]) {
  const current = executorOf(targetsOf(project).serve);
  if (!current?.startsWith("@mikkel-ol/federation-session:")) return;
  const configuredRole = current.split(":").at(-1);
  if (configuredRole !== role) {
    throw new Error(
      `Project is already configured as '${configuredRole}' and cannot be converted to '${role}'`,
    );
  }
}

function isNativeFederationProject(tree: Tree, project: Project): boolean {
  const root = normalizePath(project.root ?? "");
  return (
    executorOf(targetsOf(project).build) ===
      "@angular-architects/native-federation:build" ||
    tree.exists(path.posix.join(root, "federation.config.mjs"))
  );
}

function createNxWorkspaceAdapter(
  tree: Tree,
  location: WorkspaceLocation,
  projectName: string,
  project: Project,
) {
  const adapted = structuredClone(project);
  adapted.architect = adapted.targets;
  delete adapted.targets;
  for (const target of Object.values(adapted.architect ?? {})) {
    if (target.executor) {
      target.builder = target.executor;
      delete target.executor;
    }
  }
  location.workspacePath = "workspace.json";
  writeJson(tree, location.workspacePath, {
    version: 1,
    projects: { [projectName]: adapted },
  });
}

function restoreNxWorkspace(
  tree: Tree,
  location: WorkspaceLocation,
  projectName: string,
) {
  if (!location.workspacePath || !tree.exists(location.workspacePath)) {
    throw new Error("Native Federation did not produce the temporary Nx workspace");
  }
  const workspace = readJson(tree, location.workspacePath);
  const project = workspace.projects[projectName] as Project;
  project.targets = project.architect;
  delete project.architect;
  for (const target of Object.values(project.targets ?? {})) {
    if (target.builder) {
      target.executor = target.builder;
      delete target.builder;
    }
  }
  writeJson(tree, location.path, project);
  tree.delete(location.workspacePath);
}

function configureProject(
  tree: Tree,
  location: WorkspaceLocation,
  options: SetupOptions,
) {
  const project = readProject(tree, location, options.project);
  const targets = targetsOf(project);
  const key = location.kind === "nx" ? "executor" : "builder";
  const sessionExecutor = `@mikkel-ol/federation-session:${options.role}`;

  if (executorOf(targets.serve) !== sessionExecutor) {
    if (!targets["serve-federation"]) {
      if (!targets.serve) throw new Error("The project does not define a serve target");
      targets["serve-federation"] = targets.serve;
    }
    const executorOptions: Record<string, unknown> = {
      target: `${options.project}:serve-federation`,
    };
    if (options.role === "host") {
      executorOptions.yatsiServerUrl = options.yatsiServerUrl;
      if (options.capacity !== undefined) executorOptions.capacity = options.capacity;
    } else {
      executorOptions.remoteName = options.remoteName ?? options.project;
    }
    targets.serve = { [key]: sessionExecutor, options: executorOptions };
  }

  writeProject(tree, location, options.project, project);
  if (options.role === "host") addStageToRootComponent(tree, project, options.component);
  else ensureComponentExposure(tree, project, options.component);
}

function assertStandalone(tree: Tree, project: Project, componentOverride?: string) {
  const mainPath = browserEntry(project);
  const main = readText(tree, mainPath);
  if (!main.includes("bootstrapApplication")) {
    throw new Error("Federation Session v1 supports standalone Angular applications only");
  }
  resolveComponentPath(tree, project, componentOverride);
}

function browserEntry(project: Project): string {
  const targets = targetsOf(project);
  const options =
    targets.esbuild?.options ??
    targets.build?.options ??
    ({} as Record<string, unknown>);
  const entry = options.browser ?? options.main;
  if (typeof entry !== "string") throw new Error("Could not determine the browser entry file");
  return normalizePath(entry);
}

function resolveComponentPath(
  tree: Tree,
  project: Project,
  componentOverride?: string,
): string {
  if (componentOverride) {
    const candidate = normalizePath(componentOverride);
    if (!tree.exists(candidate)) throw new Error(`Component '${candidate}' does not exist`);
    return candidate;
  }
  const sourceRoot = normalizePath(project.sourceRoot ?? path.posix.join(project.root ?? "", "src"));
  for (const candidate of [
    path.posix.join(sourceRoot, "app/app.component.ts"),
    path.posix.join(sourceRoot, "app/app.ts"),
  ]) {
    if (tree.exists(candidate)) return candidate;
  }
  throw new Error("Could not determine the root component; pass --component");
}

function addStageToRootComponent(
  tree: Tree,
  project: Project,
  componentOverride?: string,
) {
  const componentPath = resolveComponentPath(tree, project, componentOverride);
  let source = readText(tree, componentPath);
  const parsed = ts.createSourceFile(
    componentPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const metadata = findComponentMetadata(parsed);
  const templateUrl = stringProperty(metadata, "templateUrl");
  const template = property(metadata, "template");

  if (templateUrl) {
    const templatePath = normalizePath(
      path.posix.join(path.posix.dirname(componentPath), templateUrl),
    );
    const html = readText(tree, templatePath);
    if (!html.includes("<federation-session-stage")) {
      tree.overwrite(templatePath, `${html.trimEnd()}\n\n<federation-session-stage></federation-session-stage>\n`);
    }
  } else if (template && ts.isStringLiteralLike(template.initializer)) {
    const value = template.initializer.text;
    if (!value.includes("<federation-session-stage")) {
      const replacement = `\`${escapeTemplateLiteral(value.trimEnd())}\\n\\n<federation-session-stage></federation-session-stage>\\n\``;
      source =
        source.slice(0, template.initializer.getStart(parsed)) +
        replacement +
        source.slice(template.initializer.getEnd());
    }
  } else {
    throw new Error("Root component must declare template or templateUrl");
  }

  source = addCustomElementsSchema(source, componentPath);
  tree.overwrite(componentPath, source);
}

function addCustomElementsSchema(source: string, filePath: string): string {
  const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const metadata = findComponentMetadata(parsed);
  const schemas = property(metadata, "schemas");
  let next = source;

  if (!source.includes("CUSTOM_ELEMENTS_SCHEMA")) {
    const angularImport = parsed.statements.find(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@angular/core",
    );
    if (!angularImport?.importClause?.namedBindings ||
        !ts.isNamedImports(angularImport.importClause.namedBindings)) {
      throw new Error("Root component must use named imports from @angular/core");
    }
    const named = angularImport.importClause.namedBindings;
    next =
      next.slice(0, named.elements.end) +
      ", CUSTOM_ELEMENTS_SCHEMA" +
      next.slice(named.elements.end);
  }

  const reparsed = ts.createSourceFile(filePath, next, ts.ScriptTarget.Latest, true);
  const nextMetadata = findComponentMetadata(reparsed);
  const nextSchemas = property(nextMetadata, "schemas");
  if (!nextSchemas) {
    const insertion = nextMetadata.properties.end;
    const prefix = nextMetadata.properties.length ? "," : "";
    next =
      next.slice(0, insertion) +
      `${prefix}\n  schemas: [CUSTOM_ELEMENTS_SCHEMA]` +
      next.slice(insertion);
  } else if (
    ts.isArrayLiteralExpression(nextSchemas.initializer) &&
    !nextSchemas.initializer.elements.some(
      (element) => element.getText(reparsed) === "CUSTOM_ELEMENTS_SCHEMA",
    )
  ) {
    const elements = nextSchemas.initializer.elements;
    const insertion = elements.end;
    next =
      next.slice(0, insertion) +
      `${elements.length ? ", " : ""}CUSTOM_ELEMENTS_SCHEMA` +
      next.slice(insertion);
  }
  void schemas;
  return next;
}

function ensureComponentExposure(
  tree: Tree,
  project: Project,
  componentOverride?: string,
) {
  const root = normalizePath(project.root ?? "");
  const configPath = path.posix.join(root, "federation.config.mjs");
  const source = readText(tree, configPath);
  if (/["']\.\/Component["']\s*:/.test(source)) return;

  const componentPath = resolveComponentPath(tree, project, componentOverride);
  const parsed = ts.createSourceFile(
    configPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const config = findFederationConfig(parsed);
  const exposes = property(config, "exposes");
  const relativeComponent = `./${componentPath}`;
  let next: string;
  if (exposes && ts.isObjectLiteralExpression(exposes.initializer)) {
    const insertion = exposes.initializer.properties.end;
    next =
      source.slice(0, insertion) +
      `${exposes.initializer.properties.length ? "," : ""}\n    "./Component": "${relativeComponent}"` +
      source.slice(insertion);
  } else {
    const insertion = config.properties.end;
    next =
      source.slice(0, insertion) +
      `${config.properties.length ? "," : ""}\n  exposes: {\n    "./Component": "${relativeComponent}"\n  }` +
      source.slice(insertion);
  }
  tree.overwrite(configPath, next);
}

function findComponentMetadata(source: ts.SourceFile): ts.ObjectLiteralExpression {
  let result: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Component" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      result = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!result) throw new Error("Could not find @Component metadata");
  return result;
}

function findFederationConfig(source: ts.SourceFile): ts.ObjectLiteralExpression {
  let result: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "withNativeFederation" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      result = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!result) throw new Error("Could not parse federation.config.mjs");
  return result;
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === name)),
  );
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string) {
  const value = property(object, name)?.initializer;
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function updateDependencies(tree: Tree) {
  const packageJson = readJson(tree, "package.json");
  packageJson.devDependencies ??= {};
  packageJson.devDependencies["@mikkel-ol/federation-session"] = "^22.0.0";
  packageJson.devDependencies["@angular-architects/native-federation"] = "^22.0.0";
  writeJson(tree, "package.json", packageJson);
}

function readJson(tree: Tree, filePath: string): any {
  return JSON.parse(readText(tree, filePath));
}

function writeJson(tree: Tree, filePath: string, value: unknown) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (tree.exists(filePath)) tree.overwrite(filePath, content);
  else tree.create(filePath, content);
}

function readText(tree: Tree, filePath: string): string {
  const data = tree.read(normalizePath(filePath));
  if (!data) throw new Error(`File '${filePath}' does not exist`);
  return data.toString("utf8");
}

function normalizePath(value: string) {
  return trimLeadingSlash(value.replaceAll("\\", "/"));
}

function trimLeadingSlash(value: string) {
  return value.replace(/^\/+/, "");
}

function escapeTemplateLiteral(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function isRemoteName(value: string) {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}
