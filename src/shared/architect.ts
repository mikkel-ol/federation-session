import {
  type BuilderContext,
  type BuilderOutput,
  type BuilderRun,
  targetFromTargetString,
} from "@angular-devkit/architect";
import { Observable } from "rxjs";
import path from "node:path";

export function delegateBuilder(
  targetString: string,
  context: BuilderContext,
  onSuccessfulBuild: (first: boolean) => Promise<void>,
  onScheduled?: (run: BuilderRun, completeSuccessfully: () => void) => void,
): Observable<BuilderOutput> {
  return new Observable<BuilderOutput>((subscriber) => {
    let run: BuilderRun | undefined;
    let first = true;
    let finished = false;
    let queue = Promise.resolve();

    context.addTeardown(async () => {
      await run?.stop();
    });

    void context
      .scheduleTarget(targetFromTargetString(targetString))
      .then((scheduled) => {
        run = scheduled;
        onScheduled?.(scheduled, () => {
          if (finished) return;
          finished = true;
          subscriber.next({ success: true });
          subscriber.complete();
        });
        scheduled.output.subscribe({
          next(output) {
            if (finished) return;
            queue = queue
              .then(async () => {
                if (output.success) {
                  await onSuccessfulBuild(first);
                  first = false;
                }
                subscriber.next(output);
              })
              .catch((error) => subscriber.error(error));
          },
          error: (error) => {
            if (!finished) subscriber.error(error);
          },
          complete: () => {
            void queue.then(() => {
              if (!finished) subscriber.complete();
            });
          },
        });
      })
      .catch((error) => subscriber.error(error));

    return () => {
      void run?.stop();
    };
  });
}

export async function resolveDevServerPort(
  targetString: string,
  context: BuilderContext,
): Promise<number> {
  const federationTarget = targetFromTargetString(targetString);
  const federationOptions = await context.getTargetOptions(federationTarget);
  if (typeof federationOptions.port === "number" && federationOptions.port > 0) {
    return federationOptions.port;
  }

  if (typeof federationOptions.target !== "string") {
    throw new Error(`Native Federation target ${targetString} does not declare its delegated target`);
  }

  const delegatedTarget = targetFromTargetString(federationOptions.target);
  const delegatedOptions = await context.getTargetOptions(delegatedTarget);
  if (typeof delegatedOptions.port !== "number" || delegatedOptions.port <= 0) {
    throw new Error(`Cannot determine dev-server port for ${targetString}`);
  }

  return delegatedOptions.port;
}

export async function resolveProjectRoot(
  targetString: string,
  context: BuilderContext,
): Promise<string> {
  const target = targetFromTargetString(targetString);
  const metadata = await context.getProjectMetadata(target.project);
  const root = typeof metadata.root === "string" ? metadata.root : "";
  return path.join(context.workspaceRoot, root);
}

export async function waitForDevServer(port: number, pathName = "/", timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${port}${pathName}`);
      if (response.ok) return;
      lastError = new Error(`Dev server returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError instanceof Error ? lastError : new Error("Dev server did not become ready");
}
