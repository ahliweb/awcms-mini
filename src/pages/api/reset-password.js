import { getDatabase } from "../../db/index.mjs";
import { handlePasswordResetConsume, handlePasswordResetRequest } from "../../auth/handlers/password-reset.mjs";

export const prerender = false;

export async function POST(context) {
  const url = new URL(context.request.url);
  const mode = url.searchParams.get("mode") ?? "request";

  if (mode === "consume") {
    return handlePasswordResetConsume({ request: context.request, db: getDatabase() });
  }

  return handlePasswordResetRequest({ request: context.request, db: getDatabase() });
}
