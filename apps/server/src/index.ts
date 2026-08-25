import { buildApplication } from "./app.js";
import { loadConfiguration } from "./config.js";

const configuration = loadConfiguration();
const application = await buildApplication({
  cleanupIntervalSeconds: configuration.cleanupIntervalSeconds,
  authentication: {
    bootstrapSecret: configuration.bootstrapSecret,
    openRegistration: configuration.openRegistration,
    origin: configuration.publicOrigin,
    rpId: configuration.rpId,
    secureCookies: configuration.secureCookies,
  },
  dashboardDirectory: configuration.dashboardDirectory,
  dataDirectory: configuration.dataDirectory,
  skillDistributionDirectory: configuration.skillDistributionDirectory,
  logger: true,
  publicOrigin: configuration.publicOrigin,
  retention: configuration.retention,
  trustProxy: configuration.trustProxy,
});

if (!application.yaapsData) {
  // Serving only the landing page while every product route 404s is a trap for
  // operators: restart policies act on exits, not on a degraded process.
  application.log.fatal(
    "YAAPS data initialization failed; exiting so the container restarts.",
  );
  await application.close();
  process.exit(1);
}

const stop = async (signal: NodeJS.Signals) => {
  application.log.info({ signal }, "Stopping YAAPS.");
  await application.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await application.listen({
    host: configuration.host,
    port: configuration.port,
  });
} catch (error) {
  application.log.error(error);
  process.exitCode = 1;
}
