# Payment incident investigation: account 1937

## Scope and evidence standard

The operator reported more than 105 failed GHS 500 MTN transactions for
`1937@asakaa-casino.onrender.com`, including references `DES111128276370`
and `DES111141127609`. Those counts and examples are operator observations,
not independently verified provider/database exports.

The investigation examined repository code, deployment configuration and offline
mocked regressions. Production database, authenticated Render logs, provider
request logs, account registration records, and historical deployments were not
available. Do not equate a discovered defect with proven incident attribution.
Release/deployment verification is reported separately in the delivery message.

## Answers to the operator's eight questions

1. **Is this a development/test account?** Not established. The integration
   generates checkout email from the authenticated accounts-service ID and site
   hostname. The email is consistent with account ID 1937; its appearance alone
   does not establish a test account or who controlled it.
2. **Which service is generating the requests?** Current code creates Payteller
   payments in the wallet backend, through the authenticated checkout and MoMo
   POST routes. The reported DES references match this integration's format.
   Actual incident origin is unproven without matching provider references to
   database rows and historical request/deployment logs.
3. **Why are they repeated?** Reproducible gaps permitted repeated creation after
   checkout errors, redispatch of a pending intent without a saved URL, and old
   idempotency keys bypassing a restriction check. Inherited live credentials
   could also reach payment code from insufficiently isolated tests. None of
   these establishes which mechanism produced the reported 105 failures.
4. **Is an automatic creation function running?** No creation loop was identified
   in the inspected repository. Browser polling and backend pending sweeps
   retrieve statuses; they do not initiate new payments. This does not establish
   what is running in old deployments, external scripts or provider infrastructure.
5. **Current Render deployment or older deployment?** Unknown until provider
   timestamps/source IPs and release-specific Render logs are correlated.
6. **Have requests stopped?** The patch blocks new initiation for wallet mappings
   to account ID 1937 once migration 057 and the updated routes are live. It cannot
   cancel already-issued hosted checkout links, stop an old service running old
   code, or revoke external use of provider credentials. A quiet provider request
   log after deployment is necessary to confirm incident-wide cessation.
7. **How is recurrence prevented?** Targeted persistent hold, locked durable
   send-once claim, idempotency parameter binding, rechecked 30-hour restrictions,
   per-wallet rolling dispatch limits, creation-failure cooldown, structured
   security events and test/development network isolation. Pending outcomes are
   reconciled by GET, never automatic new-transaction POST retries.
8. **Do legitimate deposits work?** Offline tests verify normal checkout,
   confirmed-payment crediting, idempotent reconciliation, exact-once credit and
   preservation of existing-payment reconciliation while the account is held.
   No live-money request was initiated for verification. Production customer
   completion still requires monitoring genuine deliberate customer payments.

## Controls and intentional behavior changes

- Both initiation routes refuse held identity 1937 with HTTP 403. No account,
  transaction or balance is deleted. This is separate from 30-hour restrictions.
- A reference is durably claimed before one outbound creation attempt. A timeout,
  restart or uncertain response cannot trigger redispatch of that reference.
  A crash between claim and send may require manual provider reconciliation.
- One dispatch per rolling minute, five/hour, fifteen/day per wallet; a definitive
  checkout-creation rejection adds a five-minute cooldown. These are backend
  controls even if a browser, script or old idempotency key submits repeatedly.
- HTTP authentication/configuration/creation errors are not invented customer
  declines. The 30-hour restriction still requires final authenticated provider
  failure in the settlement path. HTTP 408/409/429 and 5xx are uncertain.
- Known checkout URLs can be read idempotently when otherwise permitted. Amount,
  currency, owner and provider cannot change under an existing key.
- Test/development payment transports refuse external real gateway hosts.
  Node test context overrides inherited production mode. E2E credentials and URLs
  point to a local gateway stub.
- New claims retain account ID, bounded IP/user-agent/origin and release metadata.
  These aid investigation, but origin and user-agent can be spoofed. A dispatch
  claim is evidence of authorization to send, not proof the provider received it.
- Legacy allocated references are conservatively marked already dispatched during
  migration. Their backfilled timestamp is **not** a verified historical send time.
- No changes to withdrawals, callback settlement, wallets, commissions, casino or
  football business logic were made. Their live operation was not exercised.

## Read-only production evidence collection

An authorized operator should export the following privately; never publish
credentials, access tokens, customer phone numbers or full checkout URLs. Preserve
original provider and Render records before rotating credentials or redeploying
old services. Do not delete the account, transactions or logs.

Run on the wallet database using a read-only session:

```sql
BEGIN READ ONLY;
SET LOCAL search_path = wallet, public;

SELECT ua.account_user_id, p.id, p.transaction_id, p.gateway, p.amount,
       p.currency, p.status, p.created_at, p.updated_at,
       p.dispatch_started_at, p.initiation_context, p.gateway_note
FROM user_accounts ua
JOIN payment_intents p ON p.user_id = ua.user_id
WHERE ua.account_user_id = '1937'
ORDER BY p.created_at;

SELECT ua.account_user_id, p.transaction_id, p.amount, p.status,
       p.created_at, p.updated_at, p.initiation_context
FROM payment_intents p
JOIN user_accounts ua ON ua.user_id = p.user_id
WHERE p.transaction_id IN ('111128276370', '111141127609');

SELECT ua.account_user_id, date_trunc('hour', p.created_at) AS hour,
       count(*) AS intents, count(DISTINCT p.transaction_id) AS references,
       count(*) FILTER (WHERE p.status = 'FAILED') AS failed
FROM payment_intents p
JOIN user_accounts ua ON ua.user_id = p.user_id
WHERE p.created_at >= now() - interval '7 days'
GROUP BY ua.account_user_id, date_trunc('hour', p.created_at)
HAVING count(*) >= 5
ORDER BY intents DESC;

SELECT account_user_id, reason, created_at
FROM deposit_initiation_blocks WHERE account_user_id = '1937';

SELECT r.created_at, r.method, r.amount, r.reason_code, r.reason
FROM deposit_rejections r JOIN user_accounts ua ON ua.user_id = r.user_id
WHERE ua.account_user_id = '1937'
ORDER BY r.created_at DESC LIMIT 200;
COMMIT;
```

Also obtain:

1. Provider records for each unique reference: exact timestamps/timezone, creation
   requests versus repeated hosted-checkout attempts, source IP, request ID,
   merchant identity and failure reason. Distinguish 105 attempts on existing
   sessions from 105 unique payment-creation API calls.
2. Accounts-service registration/audit records for ID 1937, without deleting it.
3. Render request/application logs around both sample references and their exact
   timestamps; deployment SHA, instance and service. Compare with
   `gateway_creation_claimed`, `incident_account_blocked` and
   `initiation_rate_limited` events after rollout.
4. Inventory all services, cron jobs, workers, previews, old deployments and
   external scripts holding this merchant's credentials. Inspect the live
   database's trigger/scheduler definitions read-only; repository migrations
   cannot establish what extra production objects exist.
5. Compare unusual intent rates across accounts. Shared IP/user-agent/release
   metadata can guide further investigation but must not be used alone to block
   unrelated customers.

## If provider creation continues after rollout

First compare creation timestamps against deployment completion; requests already
in flight and existing hosted checkout attempts are not proof the hold failed.
If new creation calls continue with no matching current-backend dispatch, investigate
old deployments and externally held credentials. Coordinate provider-side
revocation/rotation and update only authorized production services. A global
credential change may affect legitimate deposits or withdrawals, so coordinate it
with the operator rather than silently disabling every customer.

Do not lift the targeted hold merely because a test passed. Preserve evidence,
identify account ownership and actual caller, and document an authorized decision.
No live-money automated testing is permitted.
