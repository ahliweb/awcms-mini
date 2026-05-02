# Schema Overview

Core table families include:

- users, sessions, login/security events
- roles, permissions, role_permissions
- TOTP credentials and recovery codes
- file_objects
- message_templates
- notification_requests, notification_delivery_logs, provider_webhook_events
- idempotency_records

Migration sources:

- `src/db/migrations/*.mjs`
