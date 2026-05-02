# Mailketing Integration

Mailketing is integrated as a backend notification provider.

- send path: `POST /api/v1/notifications/email/send`
- webhook path: `POST /api/v1/webhooks/mailketing`
- keys remain backend-only runtime secrets

See also:

- `src/services/notifications/`
