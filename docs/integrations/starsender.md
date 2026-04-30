# Starsender Integration

Starsender is integrated as a backend WhatsApp notification provider.

- send path: `POST /api/v1/notifications/whatsapp/send`
- webhook path: `POST /api/v1/webhooks/starsender`
- keys remain backend-only runtime secrets

See also:

- `src/services/notifications/`
