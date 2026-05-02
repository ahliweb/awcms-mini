# Notifications Integration

Implemented notification capabilities:

- email and WhatsApp send routes
- idempotency key handling
- request + delivery log persistence
- provider webhook event persistence
- template list/create routes

Primary routes:

- `POST /api/v1/notifications/email/send`
- `POST /api/v1/notifications/whatsapp/send`
- `GET /api/v1/notifications/:id`
- `GET /api/v1/notifications/:id/delivery-logs`
