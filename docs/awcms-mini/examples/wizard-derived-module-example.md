# Contoh Pemakaian Wizard di Modul Domain Turunan

Issue #482. Contoh end-to-end memakai
[reusable wizard form pattern](wizard-form-pattern.md) (Issue #479/#480)
pada satu modul domain turunan — melengkapi dokumen itu dengan pemakaian
nyata, bukan sekadar daftar tanggung jawab komponen.

> **Payload di dokumen ini seluruhnya dummy/non-sensitif.** Domain contoh
> memakai `asset-register` yang sama seperti
> [`minimal-domain-module.md`](minimal-domain-module.md) agar konsisten
> lintas dokumen — ganti nama domain/entitas/field sesuai kebutuhan Anda,
> jangan salin apa adanya ke production.

## Kapan memakai wizard di modul domain

Ikuti kriteria di `wizard-form-pattern.md` §Kapan memakai wizard. Contoh
konkret di sini: form registrasi aset dengan tiga kategori data (identitas
aset, lokasi, kategori/kondisi) — cukup panjang untuk manfaat dari step
terpisah, tapi tidak butuh lampiran/draft/resume di contoh ini secara
spesifik. Server-side draft persistence generik memang tersedia
(`/api/v1/form-drafts`, Issue #484) bila modul domain Anda membutuhkannya —
lihat §6 di bawah untuk pola submit yang sama, dan
[`wizard-form-pattern.md`](wizard-form-pattern.md) §Server-side draft
untuk API lengkap.

## 1. Import komponen dan helper

```astro
---
// src/pages/admin/assets/register.astro (ilustrasi — sesuaikan path modul Anda)
import AdminLayout from "../../../layouts/AdminLayout.astro";
import WizardStepper from "../../../components/ui/WizardStepper.astro";
import WizardPanel from "../../../components/ui/WizardPanel.astro";
import WizardActions from "../../../components/ui/WizardActions.astro";
import { createTranslator } from "../../../lib/i18n/translate";
import {
  createWizardState,
  getActiveWizardStep,
  getWizardProgress,
  type WizardStepDefinition
} from "../../../lib/ui/wizard-client";
---
```

## 2. Deklarasikan `WizardStepDefinition[]`

```ts
const assetRegisterSteps: WizardStepDefinition[] = [
  {
    key: "identity",
    title: "Identitas aset",
    description: "Kode aset dan nama.",
    fields: ["assetCode", "name"]
  },
  {
    key: "location",
    title: "Lokasi",
    description: "Lokasi fisik aset saat ini.",
    fields: ["officeId", "roomLabel"]
  },
  {
    key: "review",
    title: "Review",
    description: "Periksa kembali sebelum submit.",
    fields: []
  }
];
```

## 3. `createTranslator(locale)` dan label i18n sebagai prop

Sesuai `wizard-form-pattern.md` §Pola i18n — komponen wizard tidak pernah
menerjemahkan sendiri, jadi halaman pemanggil wajib mengisi setiap prop
string dari katalog:

```astro
---
const t = await createTranslator(Astro.locals.locale);
const state = createWizardState(assetRegisterSteps);
const progress = getWizardProgress(state);
---

<WizardStepper
  steps={assetRegisterSteps}
  activeStepKey={progress.activeStep.key}
  label={t("asset_register.wizard.stepper_label")}
  currentLabel={t("asset_register.wizard.step_current")}
  completedLabel={t("asset_register.wizard.step_completed")}
  pendingLabel={t("asset_register.wizard.step_pending")}
/>

<WizardPanel
  id="step-identity"
  title={t("asset_register.wizard.step_identity_title")}
  description={t("asset_register.wizard.step_identity_description")}
  errorSummaryHeading={t("asset_register.wizard.error_summary_heading")}
>
  <!-- field identitas aset di sini -->
</WizardPanel>

<WizardActions
  backLabel={t("common.back")}
  nextLabel={t("common.next")}
  submitLabel={t("common.submit")}
/>
```

## 4. Validasi per-step memakai `wizard-client.ts`

Validator murni, tanpa I/O — dipanggil dari script sisi klien sebelum
`advanceWizard` mengizinkan lanjut ke step berikutnya:

```ts
import {
  advanceWizard,
  type WizardFieldError,
  type WizardValidator
} from "../../../lib/ui/wizard-client";

const validateAssetRegisterStep: WizardValidator<Record<string, unknown>> = (
  step,
  payload
) => {
  const errors: WizardFieldError[] = [];

  if (step.key === "identity") {
    if (!String(payload.assetCode ?? "").trim()) {
      errors.push({
        field: "assetCode",
        message: t("asset_register.validation.asset_code_required")
      });
    }
    if (!String(payload.name ?? "").trim()) {
      errors.push({
        field: "name",
        message: t("asset_register.validation.name_required")
      });
    }
  }

  if (step.key === "location" && !payload.officeId) {
    errors.push({
      field: "officeId",
      message: t("asset_register.validation.office_required")
    });
  }

  return errors;
};

// Dipanggil saat user menekan "Next":
const result = advanceWizard(state, formPayload, validateAssetRegisterStep);
if (!result.advanced) {
  // render result.errors ke field terkait (lihat §5) — jangan lanjut step.
}
```

## 5. Mapping error validasi server ke field error

Endpoint domain (`POST /api/v1/assets`, pola sama seperti
`minimal-domain-module.md`) tetap memvalidasi payload lengkap di server —
respons `400 VALIDATION_ERROR` dipetakan balik ke field yang sama lewat
`mapValidationDetailsToFieldErrors`, bukan divalidasi ulang secara terpisah:

```ts
import { mapValidationDetailsToFieldErrors } from "../../../lib/ui/wizard-client";

const res = await fetch("/api/v1/assets", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "same-origin",
  body: JSON.stringify(payload)
});
const json = await res.json();

if (!res.ok && json.error?.code === "VALIDATION_ERROR") {
  const fieldErrors = mapValidationDetailsToFieldErrors(json.error.details);
  // render fieldErrors ke WizardPanel yang relevan; jangan hapus payload/state.
}
```

## 6. Submit final memakai `Idempotency-Key`

Mutation registrasi aset dianggap high-risk (menulis baris baru) — kunci
idempotency dibuat sekali per attempt submit, bukan per klik tombol
(supaya retry jaringan dengan payload sama tidak membuat baris duplikat):

```ts
import { createWizardIdempotencyKey } from "../../../lib/ui/wizard-client";

const idempotencyKey = createWizardIdempotencyKey("asset-register");

const res = await fetch("/api/v1/assets", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey
  },
  credentials: "same-origin",
  body: JSON.stringify(finalPayload)
});
```

Simpan `idempotencyKey` yang sama di closure/state selama percobaan submit
berlangsung — jangan generate ulang saat retry otomatis untuk request yang
sama, atau server akan melihatnya sebagai request baru yang berbeda.

## 7. Anti-double-submit dengan helper existing

Pakai `lockElement`/`submitJson` yang sudah ada
(`src/lib/ui/admin-form-client.ts`, dipakai `admin/settings.astro` dkk.)
untuk mengunci tombol submit selama request in-flight — komponen
`WizardActions` sendiri hanya menampilkan state `busy`/`disabled`, bukan
yang mengelola siklus fetch:

```ts
import {
  lockElement,
  readClientStrings
} from "../../../lib/ui/admin-form-client";

const strings = readClientStrings<{ pleaseWait: string }>();
const submitButton = document.querySelector<HTMLButtonElement>(
  "[data-wizard-submit]"
);
const unlock = submitButton
  ? lockElement(submitButton, strings.pleaseWait)
  : null;

try {
  // fetch submit final (§6) di sini
} finally {
  unlock?.();
}
```

## Checklist keamanan modul turunan

Turunan dari `wizard-form-pattern.md` §Keamanan, diterapkan ke contoh ini:

- [ ] Endpoint `POST /api/v1/assets` tetap memvalidasi payload lengkap di
      server — validasi client (§4) hanya untuk UX cepat.
- [ ] Endpoint memakai tenant context + ABAC default-deny + RLS (pola
      `minimal-domain-module.md`), bukan mengandalkan wizard client-side.
- [ ] `Idempotency-Key` (§6) unik per attempt submit, bukan per klik tombol.
- [ ] Aksi registrasi aset diaudit via `recordAuditEvent` di endpoint.
- [ ] Tidak ada payload disimpan ke `localStorage`/`sessionStorage` — state
      wizard hanya hidup di memori JS selama halaman terbuka (MVP, lihat
      §Server-side draft: follow-up di `wizard-form-pattern.md`).
- [ ] Semua string user-facing (§3) berasal dari `t(key)`, tidak ada
      hardcode production.
- [ ] Error server (§5) ditampilkan apa adanya dari `ERROR_CODE_KEYS`
      (`src/lib/i18n/error-messages.ts`) — tidak menampilkan stack trace.

## Lihat juga

- [`wizard-form-pattern.md`](wizard-form-pattern.md) — spesifikasi
  komponen, pola i18n lengkap, dan rancangan follow-up server-side draft.
- [`minimal-domain-module.md`](minimal-domain-module.md) — pola endpoint
  domain (`asset-register`) yang dipakai sebagai target submit di atas.
- `src/lib/ui/admin-form-client.ts` — `submitJson`/`lockElement`/
  `readClientStrings` yang dipakai bersama pola wizard ini.
