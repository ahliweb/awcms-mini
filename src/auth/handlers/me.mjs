import { createUserRepository } from "../../db/repositories/users.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAuthMe({ session, db }) {
  const sessionUser = await session?.get("user");
  if (!sessionUser?.id) {
    return json({ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } }, 401);
  }

  const users = createUserRepository(db);
  const user = await users.getUserById(sessionUser.id);

  if (!user) {
    return json({ error: { code: "NOT_FOUND", message: "User not found" } }, 401);
  }

  return json({
    id: user.id,
    email: user.email,
    name: user.name ?? user.display_name ?? null,
    role: user.role,
    avatarUrl: user.avatar_url ?? null,
  });
}
