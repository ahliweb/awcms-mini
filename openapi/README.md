# OpenAPI Contracts

Baseline OpenAPI publik tersedia di [`awcms-mini-public-api.openapi.yaml`](awcms-mini-public-api.openapi.yaml).

Kontrak REST wajib mengikuti response helper di `src/modules/_shared/api-response.ts`. Setiap endpoint baru atau berubah harus memperbarui file OpenAPI dan lulus:

```bash
bun run api:spec:check
```
