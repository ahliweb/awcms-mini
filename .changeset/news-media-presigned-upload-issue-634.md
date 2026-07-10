---
"awcms-mini": minor
---

Add the direct-to-R2 presigned upload flow for news images (Issue #634,
epic `news_portal` #631-#642/#649): `POST
/api/v1/media/news-images/upload-sessions` (create — server-generated
object key, short-lived presigned PUT URL, never a raw R2 credential),
`POST .../{id}/finalize` (high-risk, `Idempotency-Key` required), and
`POST .../{id}/cancel`.

Closes the security-auditor Critical finding on Issue #631: `finalize`
never promotes a media object to `verified` from a bare `HEAD` check.
It performs a `HEAD` (existence + real size) followed by a full `GET`,
sniffs the MIME type from the object's actual magic bytes
(`domain/news-media-mime-sniffer.ts`, allow-list-only — JPEG/PNG/WebP/
GIF), and computes a SHA-256 checksum server-side from the bytes
actually read (`application/news-media-r2-verification.ts`,
`domain/news-media-finalize-decision.ts`). A client-claimed checksum
(optional) is compared only as a transport-corruption check, never as
a substitute for the MIME sniff. Every R2 call (`Bun.S3Client`, no npm
AWS/S3 SDK) runs strictly outside any DB transaction (ADR-0006), behind
a dedicated `news-media-r2` circuit breaker + timeout
(`infrastructure/news-media-r2-client.ts`).

Adds migration `042` seeding the `news_portal.media.*` permission
catalog (`create`/`read`/`verify`/`attach`/`detach`/`delete`/
`restore`/`purge`/`cancel` — reusing Issue #633's `NEWS_MEDIA_PERMISSIONS`
constants exactly, plus a new `cancel` permission for aborting one's own
not-yet-uploaded session) and wires them into `news_portal`'s module
descriptor (`permissions`, `api`) for the first time.
