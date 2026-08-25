import { createHash, randomBytes } from "node:crypto";

import {
  createDeviceConnectionResponseSchema,
  pollDeviceConnectionResponseSchema,
  type CreateDeviceConnectionResponse,
  type PollDeviceConnectionResponse,
} from "@yaaps/contracts";

import { raiseRequestError, requestUrl } from "./http.js";

export interface GeneratedApiKey {
  hash: string;
  key: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(32).toString("base64url");
  // The public prefix is independent random data so it reveals nothing about
  // the secret material.
  const prefix = `yaaps_${randomBytes(8).toString("base64url").slice(0, 10)}`;
  const key = `${prefix}_${secret}`;
  return {
    hash: createHash("sha256").update(key, "utf8").digest("hex"),
    key,
    prefix,
  };
}

async function deviceRequest(
  apiUrl: string,
  route: string,
  body: unknown,
  fetchImplementation: typeof fetch,
): Promise<unknown> {
  const response = await fetchImplementation(requestUrl(apiUrl, route), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await raiseRequestError(response, "YAAPS connection failed");
  }
  return response.json();
}

export async function startDeviceConnection(
  apiUrl: string,
  input: { keyHash: string; keyPrefix: string; label: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<CreateDeviceConnectionResponse> {
  return createDeviceConnectionResponseSchema.parse(
    await deviceRequest(
      apiUrl,
      "/auth/device-connections",
      input,
      fetchImplementation,
    ),
  );
}

export async function pollDeviceConnection(
  apiUrl: string,
  deviceSecret: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PollDeviceConnectionResponse> {
  return pollDeviceConnectionResponseSchema.parse(
    await deviceRequest(
      apiUrl,
      "/auth/device-connections/token",
      { deviceSecret },
      fetchImplementation,
    ),
  );
}
