import { getDatabase } from "../../db/index.mjs";
import { handleAuthLogin } from "../handlers/login.mjs";

export const prerender = false;

export async function POST(context) {
  return handleAuthLogin({
    request: context.request,
    session: context.session,
    db: getDatabase(),
  });
}
