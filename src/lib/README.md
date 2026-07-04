# Shared Library Layer

`src/lib/` contains cross-cutting foundation code used by modules:

- `database/` for migration loading and future pool/transaction helpers
- `errors/` for standard error classes and response mapping
- `logging/` for structured logger setup
- `auth/` for authentication primitives
- `files/` for local/R2 storage adapters
- `i18n/` for locale helpers

Business logic belongs in `src/modules/<module>/application/`, not in this shared layer.
