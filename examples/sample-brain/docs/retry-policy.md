# Retry policy

Retry only idempotent calls (GET, PUT). A POST gets one try unless the API takes an idempotency key.

- Back off exponentially: 1 s, 2 s, 4 s, then give up and log the request ID.
- Treat HTTP 429 as a retry with the server's `Retry-After`, not your own backoff.
- A retry that finally works still logs a warning, so a flaky dependency shows up on the dashboard.

Messages are never retried automatically; they wait in the [outbox](outbox.md) for a person.
