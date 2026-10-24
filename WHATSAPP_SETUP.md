# WhatsApp order notifications

Order placement does not depend on WhatsApp. When all notification settings are absent, an order is still saved and its notification status is `not_configured`. The admin order list exposes notification status and a retry action.

Configure these values only in the server environment (Render environment settings for a future deployment); never in browser code:

- `WHATSAPP_ACCESS_TOKEN`: long-lived/system-user token with the WhatsApp Business messaging permission.
- `WHATSAPP_PHONE_NUMBER_ID`: the Cloud API phone-number ID that sends the message.
- `WHATSAPP_BUSINESS_RECIPIENT`: the business owner's WhatsApp number in international digits-only format, no `+`.
- `WHATSAPP_TEMPLATE_NAME`: an approved template name in lowercase letters, digits, and underscores.
- `WHATSAPP_API_VERSION`: optional Graph API version such as `v23.0`; defaults to `v23.0` and should be kept current with Meta's supported versions.
- `WHATSAPP_TEMPLATE_LANGUAGE`: optional approved template locale; defaults to `en_US`.

The approved template must have four body text parameters in this order: order ID, item names with quantities, total amount, and the saved order's database reference. Configure the template in WhatsApp Manager and obtain the required Meta business verification/permissions before enabling the environment values. The application sends a template message through the official WhatsApp Cloud API endpoint; it does not use browser automation.

Each checkout sends a UUID v4 `Idempotency-Key`. The database has a unique partial index on that key so a repeated checkout request returns the original order and does not trigger a second notification. Production startup creates this index before opening the listening port. If an existing database contains duplicate keys (normally only possible after a manual/imported write), index creation will fail safely; inspect and resolve the duplicate records under a separately approved data-maintenance procedure.

Definitive API rejections are marked `failed` and can be retried from Order Management. A timeout or network failure is recorded as `unknown` because Meta may already have accepted the message. The application does not automatically resend an uncertain request. After five minutes, an administrator must check Meta delivery records and either confirm that it was sent or explicitly confirm it was not accepted before retrying. This avoids automatic duplicate sends but cannot provide mathematically exactly-once delivery across an external API and MongoDB; reconciliation remains a manual step.

If settings are partially configured or invalid, the order still succeeds and its notification remains `not_configured`; no credentials or provider response details are returned to the shopper or written to logs. Test messages are mocked in the automated suite and are never sent to the business number.
