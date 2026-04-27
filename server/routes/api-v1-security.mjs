import { Hono } from "hono";

import {
  createTwoFactorService,
  TwoFactorEnrollmentError,
  TwoFactorChallengeError,
} from "../../src/services/security/two-factor.mjs";

export function routeApiV1Security(options = {}) {
  const app = new Hono();
  const twoFactor =
    options.twoFactorService ??
    createTwoFactorService({
      database: options.database,
      encryptionKey: options.runtimeConfig?.miniTotpEncryptionKey,
    });

  app.post("/2fa/setup", async (c) => {
    const user = c.get("authUser");

    if (!user?.id) {
      return c.json(
        { error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." } },
        401,
      );
    }

    try {
      const enrollment = await twoFactor.beginEnrollment({ user_id: user.id });
      return c.json({
        data: {
          credentialId: enrollment.credentialId,
          manualKey: enrollment.manualKey,
          otpauthUrl: enrollment.otpauthUrl,
          verified: enrollment.verified,
        },
      });
    } catch (error) {
      if (error instanceof TwoFactorEnrollmentError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }

      throw error;
    }
  });

  app.post("/2fa/confirm", async (c) => {
    const user = c.get("authUser");

    if (!user?.id) {
      return c.json(
        { error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." } },
        401,
      );
    }

    let body;

    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "INVALID_BODY", message: "Expected JSON body." } },
        400,
      );
    }

    const code = typeof body?.code === "string" ? body.code.trim() : "";

    if (!code) {
      return c.json(
        { error: { code: "INVALID_CODE", message: "TOTP code is required." } },
        400,
      );
    }

    try {
      const verified = await twoFactor.verifyEnrollment({
        user_id: user.id,
        code,
      });

      return c.json({
        data: {
          success: true,
          verifiedAt: verified.credential.verified_at,
          recoveryCodes: verified.recoveryCodes,
        },
      });
    } catch (error) {
      if (error instanceof TwoFactorEnrollmentError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }

      throw error;
    }
  });

  app.post("/2fa/recovery-codes/regenerate", async (c) => {
    const user = c.get("authUser");

    if (!user?.id) {
      return c.json(
        { error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." } },
        401,
      );
    }

    try {
      const regenerated = await twoFactor.regenerateRecoveryCodes({
        user_id: user.id,
      });

      return c.json({
        data: {
          success: true,
          regeneratedAt: regenerated.regeneratedAt,
          recoveryCodes: regenerated.recoveryCodes,
        },
      });
    } catch (error) {
      if (error instanceof TwoFactorEnrollmentError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }

      throw error;
    }
  });

  app.post("/2fa/disable", async (c) => {
    const user = c.get("authUser");

    if (!user?.id) {
      return c.json(
        { error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." } },
        401,
      );
    }

    let body;

    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "INVALID_BODY", message: "Expected JSON body." } },
        400,
      );
    }

    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const recoveryCode =
      typeof body?.recoveryCode === "string" ? body.recoveryCode.trim() : "";

    if (!code && !recoveryCode) {
      return c.json(
        {
          error: {
            code: "INVALID_CODE",
            message: "TOTP code or recovery code is required.",
          },
        },
        400,
      );
    }

    try {
      const result = await twoFactor.disableEnrollment({
        user_id: user.id,
        code,
        recovery_code: recoveryCode,
      });

      return c.json({
        data: {
          success: true,
          disabledAt: result.disabledAt,
        },
      });
    } catch (error) {
      if (
        error instanceof TwoFactorEnrollmentError ||
        error instanceof TwoFactorChallengeError
      ) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }

      throw error;
    }
  });

  return app;
}
