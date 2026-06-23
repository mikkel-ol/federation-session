// The exposed "./Component" is just the remote's root component module, so the
// export name follows whatever convention the remote uses. Older Angular apps
// export `AppComponent` from app.component.ts; Angular's current generator
// exports `App` from app.ts. Rather than chase names, prefer the conventional
// exports and otherwise pick the first export that carries an Angular component
// definition (the compiler stamps `ɵcmp` onto every @Component class).
export function resolveExposedComponent(
  module: Record<string, unknown>,
): unknown | undefined {
  for (const preferred of [module.default, module.AppComponent, module.App]) {
    if (isAngularComponent(preferred)) return preferred;
  }
  for (const value of Object.values(module)) {
    if (isAngularComponent(value)) return value;
  }
  return undefined;
}

export function isAngularComponent(value: unknown): boolean {
  return (
    typeof value === "function" &&
    Object.prototype.hasOwnProperty.call(value, "ɵcmp")
  );
}
