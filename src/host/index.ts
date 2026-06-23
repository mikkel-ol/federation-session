import { createBuilder, type BuilderContext } from "@angular-devkit/architect";
import open from "open";
import { delegateBuilder, resolveDevServerPort, waitForDevServer } from "../shared/architect";
import type { HostSchema } from "../shared/schema";
import { startHostGateway, type HostGateway } from "./gateway";

export default createBuilder<HostSchema>((options, context) => {
  let gateway: HostGateway | undefined;
  let starting: Promise<void> | undefined;

  context.addTeardown(async () => {
    await gateway?.close();
  });

  const start = async () => {
    if (gateway) return;
    const apiKey = process.env.YATSI_API_KEY;
    if (!apiKey) throw new Error("YATSI_API_KEY is required to start a federation session");

    const appPort = await resolveDevServerPort(options.target, context);
    await waitForDevServer(appPort);
    gateway = await startHostGateway({
      appPort,
      gatewayPort: options.gatewayPort ?? 0,
      capacity: options.capacity ?? 24,
      panel: options.panel !== false,
      yatsiServerUrl: options.yatsiServerUrl,
      apiKey,
    });

    const bold = "\x1b[1m";
    const cyan = "\x1b[36m";
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    context.logger.info("");
    context.logger.info(`  ${bold}Federation session is live${reset}`);
    context.logger.info(`  ${dim}Send this URL to anyone joining the session:${reset}`);
    context.logger.info(`  ${cyan}${bold}${gateway.inviteUrl}${reset}`);
    context.logger.info("");

    if (options.open === true) {
      await open(`${gateway.localUrl}/#join=${encodeURIComponent(gateway.joinToken)}`);
    }
  };

  return delegateBuilder(
    options.target,
    context,
    async () => {
      starting ??= start();
      await starting;
    },
    () => {
      starting ??= start();
      void starting.catch((error) => context.logger.error(error.message));
    },
  );
});
