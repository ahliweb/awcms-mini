# OpenAPI Guide

Current API spec endpoint:

- `GET /openapi.json`

The document is intentionally issue-scoped to implemented routes only.

Source:

- `server/routes/openapi.mjs`

## Contract Standard

New `/api/v1` routes should follow the AWCMS Mini application standard:

- success responses use `{ "success": true, "data": ..., "meta": ... }`
- error responses use `{ "success": false, "error": { "code": "...", "message": "..." } }`
- high-risk mutations require idempotency handling
- route handlers stay thin and delegate workflow to services
- OpenAPI updates must describe implemented behavior only

Shared helpers:

- `src/modules/_shared/api-response.mjs`
- `docs/architecture/application-standard.md`
