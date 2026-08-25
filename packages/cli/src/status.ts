import {
  healthResponseSchema,
  readinessResponseSchema,
  type HealthResponse,
  type ReadinessResponse,
} from "@yaaps/contracts";

export interface ServiceStatus {
  health: HealthResponse;
  readiness: ReadinessResponse;
}

export async function fetchServiceStatus(
  apiUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ServiceStatus> {
  const baseUrl = new URL(apiUrl);
  const healthUrl = new URL("/healthz", baseUrl);
  const readinessUrl = new URL("/readyz", baseUrl);

  const requestInit: RequestInit = {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  };
  const [healthResponse, readinessResponse] = await Promise.all([
    fetchImplementation(healthUrl, requestInit),
    fetchImplementation(readinessUrl, requestInit),
  ]);

  if (!healthResponse.ok) {
    throw new Error(
      `Health request failed with HTTP ${healthResponse.status}.`,
    );
  }

  // Readiness answers 503 with a full ReadinessResponse body when storage is
  // not ready; that is a state to report, not a transport error. Only a body
  // that does not match the contract is treated as a failed request.
  let readiness: ReadinessResponse;
  try {
    readiness = readinessResponseSchema.parse(await readinessResponse.json());
  } catch {
    throw new Error(
      `Readiness request failed with HTTP ${readinessResponse.status}.`,
    );
  }

  return {
    health: healthResponseSchema.parse(await healthResponse.json()),
    readiness,
  };
}
