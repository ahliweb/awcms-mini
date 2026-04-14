import { getDatabase } from "../../db/index.mjs";
import { handleInviteActivation } from "../../auth/handlers/activate-invite.mjs";

export const prerender = false;

export async function POST(context) {
  return handleInviteActivation({
    request: context.request,
    db: getDatabase(),
  });
}
