---
"awcms-mini": patch
---

Document the target full-online R2-only media architecture and SOP for
the new `news_portal` epic (Issue #631, epic #631-#642 plus downstream
#649 and the dependent `social-publishing` epic #643-#647) — no code,
migration, or endpoint changes in this issue.

Adds `docs/awcms-mini/news-portal/`: `full-online-r2-architecture.md`
(scope/assumptions, the key decision to keep news media on a **separate**
R2 bucket and credentials from `sync-storage`'s existing private object
sync queue, the `NEWS_MEDIA_R2_*` env var naming convention, object key
convention, upload flow diagrams, presigned URL lifecycle, MIME/
extension/checksum validation order, CORS, custom domain, Cache-Control,
credential rotation, and a practical mapping to ISO/IEC 27001, 27002,
27005, 27017, 27018, 27701, 27034, ISO 22301, OWASP ASVS, and OWASP API
Security Top 10), `r2-upload-sop.md`, `r2-security-checklist.md`,
`r2-incident-response.md`, `r2-backup-lifecycle.md`, and
`newsroom-user-guide.md`.

Adds skill `.claude/skills/awcms-mini-news-portal/SKILL.md` summarizing
the architecture decisions for follow-up issues #632-#642/#649, with a
per-issue status table (#631 done, the rest not started with a scope
summary each) so later issues don't need to re-read the full GitHub
issue bodies. Registers the skill in `AGENTS.md` and
`.claude/skills/README.md`, and links the new docs from
`docs/awcms-mini/README.md` and `docs/awcms-mini/deployment-profiles.md`
(explicit: this mode does not apply to offline/LAN deployments).
