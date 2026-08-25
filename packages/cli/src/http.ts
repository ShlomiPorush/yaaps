import { publicErrorSchema } from "@yaaps/contracts";

export function requestUrl(apiUrl: string, route: string): URL {
  return new URL(route.replace(/^\//u, ""), `${apiUrl.replace(/\/$/u, "")}/`);
}

export async function raiseRequestError(
  response: Response,
  messagePrefix = "YAAPS request failed",
): Promise<never> {
  const raw: unknown = await response.json().catch(() => undefined);
  const parsed = publicErrorSchema.safeParse(raw);
  throw new Error(
    parsed.success
      ? `${messagePrefix} (${parsed.data.error.code}): ${parsed.data.error.message}`
      : `${messagePrefix} with HTTP ${response.status}.`,
  );
}
