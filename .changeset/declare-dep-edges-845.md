---
"awcms-mini": patch
---

Hilangkan baseline 16 undeclared module-dependency edge yang dibekukan #826; gate `module-declared-dependencies` kini memvalidasi graph import lintas-modul yang LENGKAP (Issue #845, epic #818).

#826 merilis gate dengan baseline 16 edge tak-terdeklarasi di 10 modul (mendeklarasikan semuanya sekaligus di luar scope #826). #845 menuntaskannya ke nol:

- 15 edge adalah import layering-valid nyata dan kini dideklarasikan di `dependencies` masing-masing `module.ts` (blog-content, document-infrastructure, form-drafts, identity-access, module-management, news-portal, organization-structure, profile-identity, reference-data, social-publishing — mayoritas `-> logging`).
- Edge ke-16, `profile_identity -> domain_event_runtime`, adalah cycle nyata (`domain_event_runtime -> identity_access -> profile_identity`). Diputus dengan menyuntikkan producer outbox sebagai `DomainEventAppendPort` (`_shared/ports/domain-event-append-port.ts`, hanya TYPE, tanpa import implementasi) di composition root (route `POST /api/v1/profile-merge-requests/{id}/execute`) alih-alih meng-import langsung — pola inversi ADR-0011 yang sama dengan pasangan port blog_content/news_portal.

Dengan baseline hilang, setiap import lintas-modul baru yang tak dideklarasikan gagal seketika — persis yang akan menangkap #826 saat authoring. Tanpa perubahan skema/runtime perilaku; murni deklarasi graph + inversi dependensi.
