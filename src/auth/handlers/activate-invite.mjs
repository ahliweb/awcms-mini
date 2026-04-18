import { getDatabase } from "../../db/index.mjs";
import { resolveTrustedClientIp } from "../../security/client-ip.mjs";
import { TurnstileValidationError, validateTurnstileToken } from "../../security/turnstile.mjs";
import { UserInviteError, createUserService } from "../../services/users/service.mjs";

function redirect(location, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: location,
    },
  });
}

function activationRedirectUrl(requestUrl, params) {
  const url = new URL("/activate", requestUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export async function handleInviteActivation({ request, db = getDatabase() }) {
  const formData = await request.formData();
  const token = typeof formData.get("token") === "string" ? formData.get("token").trim() : "";
  const displayName = typeof formData.get("display_name") === "string" ? formData.get("display_name") : "";
  const password = typeof formData.get("password") === "string" ? formData.get("password") : "";
  const turnstileToken = typeof formData.get("cf-turnstile-response") === "string" ? formData.get("cf-turnstile-response") : "";

  const users = createUserService({ database: db });

  try {
    await validateTurnstileToken({
      token: turnstileToken,
      expectedAction: "invite_activation",
      remoteIp: resolveTrustedClientIp(request),
    });
  } catch (error) {
    if (error instanceof TurnstileValidationError) {
      return redirect(
        activationRedirectUrl(request.url, {
          token,
          error: "REQUEST_VERIFICATION_FAILED",
        }),
      );
    }

    throw error;
  }

  try {
    await users.activateInvite({
      token,
      display_name: displayName,
      password,
    });

    return redirect(activationRedirectUrl(request.url, { status: "success" }));
  } catch (error) {
    if (error instanceof UserInviteError) {
      return redirect(
        activationRedirectUrl(request.url, {
          token,
          error: error.code,
        }),
      );
    }

    throw error;
  }
}
