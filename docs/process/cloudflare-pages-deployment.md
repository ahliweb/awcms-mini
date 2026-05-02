# Cloudflare Pages Frontend Deployment

## Purpose

Define the current frontend deployment baseline for Cloudflare Pages while keeping the Hono API as the only data and auth source.
That boundary preserves the upstream EmDash application shape while letting Pages/Workers talk only to Hono.

## Required Frontend Boundaries

- Frontend traffic is served from Cloudflare Pages.
- Frontend data and auth calls must go through `PUBLIC_API_BASE_URL`.
- Frontend must not use direct PostgreSQL, Supabase, or provider API keys.
- Backend secrets (`DATABASE_URL`, `TURNSTILE_SECRET_KEY`, `R2_SECRET_ACCESS_KEY`, `MAILKETING_API_KEY`, `STARSENDER_API_KEY`) stay backend-only.

## Required Public Variables

- `PUBLIC_API_BASE_URL`
- optional `PUBLIC_TURNSTILE_SITE_KEY`

Public variables can be set in Cloudflare Pages production and preview environment settings.

## Build Settings

- Framework preset: Astro
- Build command: `pnpm build`
- Output directory: `dist`
- Node compatibility: enabled as required by current Astro adapter/runtime settings

## API And CORS Alignment

- `PUBLIC_API_BASE_URL` must target the reviewed Hono API origin.
- Backend `EDGE_API_ALLOWED_ORIGINS` should include frontend origins served by Cloudflare Pages.
- If preview domains are used, include preview origins in `EDGE_API_ALLOWED_ORIGINS`.

## Turnstile Frontend Rendering

- Frontend widgets should use `PUBLIC_TURNSTILE_SITE_KEY`.
- `TURNSTILE_SECRET_KEY` remains backend-only.

## Public Asset Caching

- Static frontend assets use Cloudflare Pages caching defaults.
- Public file URLs can use a reviewed public R2 base URL only for explicitly public objects.
- Protected objects should keep signed access through backend-managed routes.

## Validation

- `pnpm build`
- `pnpm lint`
- Confirm frontend runtime calls point to `PUBLIC_API_BASE_URL`.
- Confirm no backend secrets are present in frontend bundle or public env settings.

## References

- `docs/process/coolify-deployment.md`
- `docs/architecture/runtime-config.md`
- `docs/process/migration-deployment-checklist.md`
