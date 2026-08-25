import {
  createDeviceConnectionRequestSchema,
  decideDeviceConnectionRequestSchema,
  pollDeviceConnectionRequestSchema,
} from "@yaaps/contracts";
import type { FastifyInstance } from "fastify";

import {
  DEVICE_CONNECTION_POLL_INTERVAL_SECONDS,
  type DeviceConnectionRepository,
} from "./device-connections.js";
import type { AuthenticationRepository } from "./repository.js";
import { requireBrowserCsrf, requireBrowserSession } from "./routes.js";

export interface DeviceConnectionRouteOptions {
  authentication: AuthenticationRepository;
  connections: DeviceConnectionRepository;
  publicOrigin: string;
  secureCookies: boolean;
}

export async function registerDeviceConnectionRoutes(
  application: FastifyInstance,
  options: DeviceConnectionRouteOptions,
): Promise<void> {
  const limited = { rateLimit: { max: 30, timeWindow: "1 minute" } };

  application.post(
    "/auth/device-connections",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = createDeviceConnectionRequestSchema.parse(request.body);
      const created = await options.connections.create(body);
      const verificationUrl = new URL(
        "/dashboard/connect/approve",
        options.publicOrigin,
      );
      const verificationUrlComplete = new URL(verificationUrl);
      verificationUrlComplete.searchParams.set("code", created.userCode);
      return reply.code(201).send({
        deviceSecret: created.deviceSecret,
        expiresAt: created.expiresAt,
        intervalSeconds: DEVICE_CONNECTION_POLL_INTERVAL_SECONDS,
        userCode: created.userCode,
        verificationUrl: verificationUrl.toString(),
        verificationUrlComplete: verificationUrlComplete.toString(),
      });
    },
  );

  application.post(
    "/auth/device-connections/token",
    { config: limited },
    async (request) => {
      const body = pollDeviceConnectionRequestSchema.parse(request.body);
      return options.connections.poll(body.deviceSecret);
    },
  );

  // The user code is an approval capability: accepted via POST body so it never
  // lands in request logs or browser history the way a path/query segment does.
  application.post(
    "/auth/device-connections/lookup",
    { config: limited },
    async (request) => {
      await requireBrowserSession(
        request,
        options.authentication,
        options.secureCookies,
      );
      const body = decideDeviceConnectionRequestSchema.parse(request.body);
      return options.connections.getPending(body.userCode);
    },
  );

  application.post<{ Params: { id: string } }>(
    "/auth/device-connections/:id/approve",
    async (request) => {
      const session = await requireBrowserSession(
        request,
        options.authentication,
        options.secureCookies,
      );
      requireBrowserCsrf(
        request,
        session,
        options.authentication,
        options.secureCookies,
      );
      const body = decideDeviceConnectionRequestSchema.parse(request.body);
      return options.connections.approve({
        id: request.params.id,
        userCode: body.userCode,
        userId: session.userId,
      });
    },
  );

  application.post<{ Params: { id: string } }>(
    "/auth/device-connections/:id/deny",
    async (request, reply) => {
      const session = await requireBrowserSession(
        request,
        options.authentication,
        options.secureCookies,
      );
      requireBrowserCsrf(
        request,
        session,
        options.authentication,
        options.secureCookies,
      );
      const body = decideDeviceConnectionRequestSchema.parse(request.body);
      await options.connections.deny({
        id: request.params.id,
        userCode: body.userCode,
        userId: session.userId,
      });
      return reply.code(204).send();
    },
  );
}
