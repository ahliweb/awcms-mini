import { Hono } from "hono";

function createJsonSchemaRef(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function createOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "AWCMS Mini Hono API",
      version: "v1",
      description:
        "Issue-scoped OpenAPI document for the currently implemented Hono API routes.",
    },
    servers: [{ url: "/", description: "Current deployment origin" }],
    tags: [
      { name: "health", description: "Service health and runtime posture." },
      { name: "api", description: "API version metadata." },
      { name: "auth", description: "Authentication and session routes." },
      { name: "authorization", description: "RBAC and ABAC protected catalog routes." },
      { name: "security", description: "Two-factor enrollment and recovery routes." },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["health"],
          summary: "Health check",
          responses: {
            200: {
              description: "Service is healthy.",
              content: { "application/json": { schema: createJsonSchemaRef("HealthResponse") } },
            },
            503: {
              description: "Service is degraded.",
              content: { "application/json": { schema: createJsonSchemaRef("HealthResponse") } },
            },
          },
        },
      },
      "/api/v1": {
        get: {
          tags: ["api"],
          summary: "API version metadata",
          responses: {
            200: {
              description: "Version metadata.",
              content: { "application/json": { schema: createJsonSchemaRef("VersionResponse") } },
            },
          },
        },
      },
      "/api/v1/auth/login": {
        post: {
          tags: ["auth"],
          summary: "Login with password and Turnstile",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createJsonSchemaRef("LoginRequest"),
              },
            },
          },
          responses: {
            200: {
              description: "Login succeeded.",
              content: { "application/json": { schema: createJsonSchemaRef("TokenPairEnvelope") } },
            },
            400: {
              description: "Missing or invalid credentials payload.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            401: {
              description: "Credential check failed.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            403: {
              description: "Turnstile failed or second factor is required.",
              content: {
                "application/json": {
                  schema: createJsonSchemaRef("TwoFactorChallengeEnvelope"),
                },
              },
            },
          },
        },
      },
      "/api/v1/auth/login/verify-2fa": {
        post: {
          tags: ["auth"],
          summary: "Complete login with TOTP or recovery code",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createJsonSchemaRef("VerifyTwoFactorRequest"),
              },
            },
          },
          responses: {
            200: {
              description: "Second factor accepted.",
              content: { "application/json": { schema: createJsonSchemaRef("TokenPairEnvelope") } },
            },
            400: {
              description: "Missing or invalid challenge payload.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            401: {
              description: "Credential check failed.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
      "/api/v1/auth/logout": {
        post: {
          tags: ["auth"],
          summary: "Revoke current session",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "Session revoked.",
              content: { "application/json": { schema: createJsonSchemaRef("LogoutEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
      "/api/v1/auth/refresh": {
        post: {
          tags: ["auth"],
          summary: "Rotate refresh token",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createJsonSchemaRef("RefreshRequest"),
              },
            },
          },
          responses: {
            200: {
              description: "Refresh succeeded.",
              content: { "application/json": { schema: createJsonSchemaRef("TokenPairEnvelope") } },
            },
            400: {
              description: "Missing refresh token.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            401: {
              description: "Refresh token invalid.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
      "/api/v1/auth/me": {
        get: {
          tags: ["auth"],
          summary: "Current authenticated user",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "Current user and session.",
              content: { "application/json": { schema: createJsonSchemaRef("MeEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
      "/api/v1/roles": {
        get: {
          tags: ["authorization"],
          summary: "List roles",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "Role catalog.",
              content: { "application/json": { schema: createJsonSchemaRef("RolesEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            403: {
              description: "Permission denied.",
              content: { "application/json": { schema: createJsonSchemaRef("ForbiddenEnvelope") } },
            },
          },
        },
      },
      "/api/v1/permissions": {
        get: {
          tags: ["authorization"],
          summary: "List permissions",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "Permission catalog.",
              content: { "application/json": { schema: createJsonSchemaRef("PermissionsEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            403: {
              description: "Permission denied.",
              content: { "application/json": { schema: createJsonSchemaRef("ForbiddenEnvelope") } },
            },
          },
        },
      },
      "/api/v1/security/2fa/setup": {
        post: {
          tags: ["security"],
          summary: "Begin TOTP enrollment",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "Enrollment secret created.",
              content: { "application/json": { schema: createJsonSchemaRef("TwoFactorSetupEnvelope") } },
            },
            400: {
              description: "Enrollment rejected.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
      "/api/v1/security/2fa/confirm": {
        post: {
          tags: ["security"],
          summary: "Confirm TOTP enrollment",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createJsonSchemaRef("TwoFactorCodeRequest"),
              },
            },
          },
          responses: {
            200: {
              description: "Enrollment verified.",
              content: { "application/json": { schema: createJsonSchemaRef("TwoFactorConfirmEnvelope") } },
            },
            400: {
              description: "Invalid or missing TOTP code.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
      "/api/v1/security/2fa/recovery-codes/regenerate": {
        post: {
          tags: ["security"],
          summary: "Regenerate recovery codes",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "Recovery codes regenerated.",
              content: { "application/json": { schema: createJsonSchemaRef("TwoFactorRecoveryCodesEnvelope") } },
            },
            400: {
              description: "Regeneration rejected.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
      "/api/v1/security/2fa/disable": {
        post: {
          tags: ["security"],
          summary: "Disable enrolled TOTP",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createJsonSchemaRef("TwoFactorDisableRequest"),
              },
            },
          },
          responses: {
            200: {
              description: "TOTP disabled.",
              content: { "application/json": { schema: createJsonSchemaRef("TwoFactorDisableEnvelope") } },
            },
            400: {
              description: "Invalid challenge payload.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
            401: {
              description: "Authentication required.",
              content: { "application/json": { schema: createJsonSchemaRef("ErrorEnvelope") } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        ErrorEnvelope: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        ForbiddenEnvelope: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "details"],
              properties: {
                code: { const: "FORBIDDEN" },
                message: { type: "string" },
                details: {
                  type: "object",
                  properties: {
                    permissionCode: { type: "string" },
                    reason: { type: ["string", "null"] },
                  },
                  additionalProperties: true,
                },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        VersionResponse: {
          type: "object",
          required: ["version", "service", "timestamp"],
          properties: {
            version: { type: "string" },
            service: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
        HealthResponse: {
          type: "object",
          required: ["ok", "service", "version", "checks", "timestamp"],
          properties: {
            ok: { type: "boolean" },
            service: { type: "string" },
            version: { type: "string" },
            checks: { type: "object", additionalProperties: true },
            timestamp: { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password", "turnstileToken"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
            turnstileToken: { type: "string" },
          },
          additionalProperties: true,
        },
        VerifyTwoFactorRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
            code: { type: "string" },
            recoveryCode: { type: "string" },
          },
          additionalProperties: true,
        },
        RefreshRequest: {
          type: "object",
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string" },
          },
          additionalProperties: false,
        },
        TokenPairEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: {
              type: "object",
              required: ["tokenType", "accessToken", "refreshToken", "user", "session"],
              properties: {
                tokenType: { type: "string" },
                accessToken: { type: "string" },
                refreshToken: { type: "string" },
                user: { type: "object", additionalProperties: true },
                session: { type: "object", additionalProperties: true },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        TwoFactorChallengeEnvelope: {
          type: "object",
          required: ["error", "data"],
          properties: {
            error: createJsonSchemaRef("ErrorEnvelope").properties?.error ?? {
              type: "object",
              additionalProperties: true,
            },
            data: {
              type: "object",
              required: ["requiresTwoFactor", "challenge"],
              properties: {
                requiresTwoFactor: { type: "boolean" },
                challenge: {
                  type: "object",
                  required: ["type"],
                  properties: {
                    type: { const: "totp_or_recovery_code" },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        LogoutEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: {
              type: "object",
              required: ["success", "session"],
              properties: {
                success: { type: "boolean" },
                session: { type: "object", additionalProperties: true },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        MeEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: {
              type: "object",
              required: ["user", "session"],
              properties: {
                user: { type: "object", additionalProperties: true },
                session: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        RolesEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          additionalProperties: false,
        },
        PermissionsEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          additionalProperties: false,
        },
        TwoFactorSetupEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        },
        TwoFactorCodeRequest: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
          },
          additionalProperties: false,
        },
        TwoFactorConfirmEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        },
        TwoFactorRecoveryCodesEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        },
        TwoFactorDisableRequest: {
          type: "object",
          properties: {
            code: { type: "string" },
            recoveryCode: { type: "string" },
          },
          additionalProperties: false,
        },
        TwoFactorDisableEnvelope: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        },
      },
    },
  };
}

export function routeOpenApi() {
  const app = new Hono();

  app.get("/openapi.json", (c) => {
    return c.json(createOpenApiDocument());
  });

  return app;
}
