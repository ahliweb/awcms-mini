---
"awcms-mini": patch
---

Accessibility: give the compact "add identifier / address / channel" inline
forms on the profile-identity detail screen (`admin/profile-identity/[id].astro`)
programmatic labels. These `<select>`/`<input>` controls previously had no
associated `<label>` (WCAG 2.2 AA 1.3.1 / 4.1.2 — a screen reader announced
them only by their surrounding text), and the city field used a hardcoded
English `placeholder="City"` that bypassed i18n. Each control now carries an
`aria-label` sourced from the message catalog, and the city placeholder is
translated. Five new keys added to `en.po`/`id.po` (identifier type, city,
country code, linked identifier, channel type). Markup/i18n only — no behavior
or validation change.
