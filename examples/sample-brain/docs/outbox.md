# Message outbox

Agents draft messages; people send them. Every outgoing message (chat, mail, SMS) is staged
here first and only goes out after someone reads it.

A send that fails stays in the outbox with its error. See the [retry policy](retry-policy.md)
for why it is not retried on its own.
