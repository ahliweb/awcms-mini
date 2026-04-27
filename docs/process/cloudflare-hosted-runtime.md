# Cloudflare Hosted Runtime

## Status

Historical reference only.

## Purpose

This runbook preserves the earlier Cloudflare-hosted runtime path as historical reference.

The current maintained deployment baseline is `docs/process/coolify-deployment.md`.

## Historical Baseline

This document is not current operator guidance.

It describes an earlier Cloudflare-hosted runtime model that used a Cloudflare runtime as the application backend.

The maintained baseline today is:

1. Browser to Cloudflare
2. Cloudflare serves the frontend hostname
3. Hono on Coolify serves backend API and admin-integrated runtime behavior
4. Hono connects to PostgreSQL on the protected VPS

## Historical Notes

- Earlier Cloudflare runtime work used `MINI_RUNTIME_TARGET=cloudflare`.
- Earlier drafts also documented Worker-specific bindings and transport assumptions that are no longer part of the maintained baseline.
- Those assumptions are no longer the supported production posture for this repository.

## Use Instead

- `docs/process/coolify-deployment.md` for the maintained deployment baseline
- `docs/process/runtime-smoke-test.md` for the current verification path
- `docs/process/migration-deployment-checklist.md` for release validation
- `docs/process/coolify-deployment.md` for the current backend transport decision

## Cross-References

- `docs/process/coolify-deployment.md`
- `docs/process/runtime-smoke-test.md`
- `docs/process/migration-deployment-checklist.md`
- `docs/process/coolify-deployment.md`
