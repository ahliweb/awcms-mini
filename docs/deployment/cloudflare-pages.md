# Cloudflare Pages Deployment

Use `docs/process/cloudflare-pages-deployment.md` as the canonical guide.

Key contract:

- frontend calls backend via `PUBLIC_API_BASE_URL`
- frontend uses `PUBLIC_TURNSTILE_SITE_KEY` only
- backend secrets never go into Pages public env vars
