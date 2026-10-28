import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
import {
  checkTellerStatus,
  checkoutEmail,
  canonicalTellerSubscriberNumber,
  createPaymentIntent,
  loadTellerConfig,
  newTxId,
  paidPesewas,
  reasonText,
  TellerConfigurationError,
  TellerRequestError,
  depositReference,
  verdict,
  type MomoNetwork,
} from "../services/teller.js";
import {
  checkPaytellerPayment,
  createPaytellerPayment,
  loadPaytellerConfig,
  paytellerPaidPesewas,
  paytellerVerdict,
  PaytellerConfigurationError,
  PaytellerRequestError,
} from "../services/payteller.js";
import { noteIntent, reopenFailedIntent, settleIntent } from "../services/tellerSettlement.js";
import { checkDeposit, LimitError } from "../services/responsibleGaming.js";
import { partnerOf } from "../services/affiliates.js";
import { permissionsOf } from "../services/partnerPlatform.js";
import { PAYMENTS_OFF_MESSAGE, paymentsEnabled } from "../services/paymentSettings.js";
import {
  acceptRules, amountText, fundsOf, getMoneyRules, hasAcceptedRules, MAX_DEPOSIT, MoneyRuleError, publicRules,
} from "../services/moneyRules.js";
import {
  checkRegisteredNumber, confirmDepositPhone, DepositGuardError, depositState, localNumber, lockedNumber,
  PHONE_NOT_CONFIRMED_MESSAGE,
} from "../services/depositGuard.js";
import { activeDepositRestriction } from "../services/depositRestrictions.js";

/* the minimum deposit is the admin's live setting (Admin -> Betting & withdrawal settings; GHS 20 by default) */
const NETWORKS: readonly MomoNetwork[] = ["MTN", "VDF", "ATL", "TGO"];

// Momo prompts TheTeller hasn't answered yet; the status route reports these as pending without asking.
// In memory only: after a restart the status check and the background recheck take over.
const momoWaiting = new Set<string>();

function siteUrl(): string {
  return (process.env.SITE_URL ?? process.env.PUBLIC_URL ?? "http://localhost:8000").replace(/\/+$/, "");
}

function readAmount(raw: unknown, min: number): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const value = typeof raw === "string" ? raw.trim() : String(raw);
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const n = Number(value);
  const minor = Math.round(n * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  const amount = minor / 100;
  if (amount < min || amount > MAX_DEPOSIT) return null;
  return amount;
}
const ghs = (n: number) => "GHS " + amountText(n);

const clientStatus = (dbStatus: string) =>
  dbStatus === "CONFIRMED" ? "approved" : dbStatus === "PENDING" ? "pending" : "declined";

/** A partner whose deposits an admin switched off (players, and partners with deposits on, pay in as usual). */
async function partnerDepositsOff(db: Pool, userId: string): Promise<boolean> {
  const a = await partnerOf(db, userId);
  if (!a || a.status === "PENDING" || a.status === "REJECTED") return false;
  return !(await permissionsOf(db, a)).effective.wallet_deposits;
}

/** One deposit request as it arrived, for the record when our checks refuse it. */
interface DepositAttempt {
  userId: string; method: "momo" | "checkout"; amount: unknown; currency: unknown;
  network?: unknown; phone?: unknown; key: unknown;
  context?: { account_id: string; ip: string; user_agent: string; origin: string; release: string };
}

export function paymentsRouter(db: Pool): Router {
  const router = Router();
  const initiationContext = (req: Request, accountId: string): NonNullable<DepositAttempt["context"]> => ({
    account_id: accountId,
    ip: String(req.ip ?? req.socket?.remoteAddress ?? "").slice(0, 100),
    user_agent: String(req.headers?.["user-agent"] ?? "").slice(0, 300),
    origin: String(req.headers?.origin ?? "").slice(0, 200),
    release: (process.env.RENDER_GIT_COMMIT ?? "local").slice(0, 40),
  });

  /* A request our checks refuse never reaches TheTeller: it's recorded (who, how much, when, why) and answered here.
     Recording never stands in the way of the answer: a failure to write is logged. */
  async function reject(res: Response, status: number, code: string, message: string, a: DepositAttempt, extra: Record<string, unknown> = {}) {
    try {
      const n = Number(a.amount);
      const numeric = a.amount !== null && a.amount !== "" && typeof a.amount !== "boolean" && Number.isFinite(n) && Math.abs(n) < 1e12;
      const text = (v: unknown, max: number) => (v === undefined || v === null || v === "" ? null : String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, max));
      await db.query(
        `INSERT INTO deposit_rejections (user_id, method, amount, amount_raw, currency, network, payer_phone, idempotency_key, reason_code, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [a.userId, a.method, numeric ? Math.round(n * 100) / 100 : null, numeric ? null : text(a.amount, 40), text(a.currency, 10),
          text(a.network, 10), text(a.phone, 20), text(a.key, 120), code, message.slice(0, 500)]);
    } catch (e) {
      console.error("[deposit] couldn't record a refused request (%s): %s", code, (e as Error).message);
    }
    res.status(status).json({ error: code, message, ...extra });
  }

  /* The main admin's Payteller switch (Admin -> Payteller Payment Settings): while it's OFF no new deposit can start.
     Only the routes that start a payment ask; checking and crediting payments already started never does. */
  async function refuseWhenOff(res: Response, a: DepositAttempt): Promise<boolean> {
    const block = await db.query(
      `SELECT 1 FROM deposit_initiation_blocks b JOIN user_accounts ua ON ua.account_user_id = b.account_user_id
        WHERE ua.user_id = $1`, [a.userId]);
    if (block.rowCount) {
      console.warn("[payment/security] %s", JSON.stringify({ event: "incident_account_blocked", user_id: a.userId, ...a.context }));
      await reject(res, 403, "deposit_investigation_hold", "New deposits on this account are temporarily held for payment-security review. Contact support.", a);
      return true;
    }
    if (await paymentsEnabled(db)) return false;
    await reject(res, 503, "payments_off", PAYMENTS_OFF_MESSAGE, a);
    return true;
  }

  /* the amount against the live minimum deposit (and the largest single deposit) */
  async function depositAmount(raw: unknown, res: Response, a: DepositAttempt): Promise<number | null> {
    const rules = await getMoneyRules(db);
    const amt = readAmount(raw, rules.min_deposit);
    if (amt === null) {
      await reject(res, 400, "invalid_amount", `Amount must be between ${ghs(rules.min_deposit)} and ${ghs(MAX_DEPOSIT)}`, a);
      return null;
    }
    return amt;
  }
  /* deposit limits and breaks are enforced here, whatever the page shows */
  /* A new deposit's checks and its intent, under one per-player lock: deposits started at once can no longer all pass
     a limit only one of them fits (each now sees the others). Only one payment may be waiting for approval at a time,
     while a retried key returns its intent. */
  const MAX_OPEN_PROMPTS = 1;
  async function openIntent(
    userId: string, amount: number, key: string, redirectUrl: string, res: Response, a: DepositAttempt,
    network: string | null = null, gateway: "teller" | "payteller" = "teller"
  ) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["deposit:" + userId]);
      const restriction = await activeDepositRestriction(client, userId);
      if (restriction) {
        await client.query("ROLLBACK");
        await reject(res, 429, "deposit_restricted",
          "Your previous deposit attempt was unsuccessful. For payment security, another deposit attempt will be available after 30 hours.",
          a, { available_at: restriction.expires_at, retry_after_seconds: restriction.retry_after_seconds });
        return null;
      }
      const replay = await client.query(`SELECT 1 FROM payment_intents WHERE idempotency_key = $1 AND user_id = $2`, [key, userId]);
      if (!replay.rowCount) {
        try {
          await checkDeposit(client, userId, amount);
        } catch (e) {
          if (!(e instanceof LimitError)) throw e;
          await client.query("ROLLBACK");
          await reject(res, e.status, e.code, e.message, a);
          return null;
        }
        const open = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payment_intents WHERE user_id = $1 AND status = 'PENDING'
            AND (transaction_id IS NOT NULL OR dispatch_started_at IS NOT NULL)
            AND created_at > now() - interval '10 minutes'`, [userId]);
        if (open.rows[0]!.n >= MAX_OPEN_PROMPTS) {
          await client.query("ROLLBACK");
          await reject(res, 429, "too_many_pending", "You already have a payment waiting for approval. Approve it, or wait a few minutes for it to expire, before starting another.", a);
          return null;
        }
      }
      const intent = await createPaymentIntent(client, userId, amount, "GHS", key, redirectUrl, network, gateway);
      await client.query("COMMIT");
      return intent;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (e instanceof TellerRequestError) {
        await reject(res, 409, "key_reused", e.message, a);
        return null;
      }
      throw e;
    } finally {
      client.release();
    }
  }
  /* The database unique index is authoritative; retry only if a random 12-digit id collides with another intent. */
  async function claimTxId(intentId: string, userId: string, res: Response, a: DepositAttempt): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const txId = newTxId();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["deposit:" + userId]);
        const restriction = await activeDepositRestriction(client, userId);
        if (restriction) {
          await client.query("ROLLBACK");
          await reject(res, 429, "deposit_restricted", "Deposits are temporarily restricted after a provider-confirmed failure.", a,
            { available_at: restriction.expires_at, retry_after_seconds: restriction.retry_after_seconds });
          return null;
        }
        const rate = await client.query<{ minute: number; hour: number; day: number; failures: number }>(
          `SELECT count(*) FILTER (WHERE dispatch_started_at > now() - interval '1 minute')::int AS minute,
                  count(*) FILTER (WHERE dispatch_started_at > now() - interval '1 hour')::int AS hour,
                  count(*) FILTER (WHERE status = 'FAILED' AND dispatch_started_at > now() - interval '5 minutes')::int AS failures,
                  count(*)::int AS day
             FROM payment_intents WHERE user_id = $1 AND dispatch_started_at > now() - interval '1 day'`, [userId]);
        const recent = rate.rows[0]!;
        if (recent.minute >= 1 || recent.failures >= 1 || recent.hour >= 5 || recent.day >= 15) {
          await client.query("ROLLBACK");
          const seconds = recent.day >= 15 ? 86400 : recent.hour >= 5 ? 3600 : recent.failures ? 300 : 60;
          console.warn("[payment/security] %s", JSON.stringify({ event: "initiation_rate_limited", user_id: userId, ...recent, ...a.context }));
          res.setHeader("Retry-After", String(seconds));
          await reject(res, 429, "deposit_rate_limited", "Too many deposit requests. Please wait before deliberately starting another deposit.", a,
            { retry_after_seconds: seconds });
          return null;
        }
        const { rowCount } = await client.query(
          `UPDATE payment_intents SET transaction_id = $1, dispatch_started_at = now(),
                  initiation_context = $3::jsonb, updated_at = now()
            WHERE id = $2 AND user_id = $4 AND status = 'PENDING'
              AND transaction_id IS NULL AND dispatch_started_at IS NULL`,
          [txId, intentId, JSON.stringify(a.context ?? {}), userId]);
        await client.query("COMMIT");
        if (!rowCount) await reject(res, 409, "payment_pending", "This payment has already started. Check deposit history; it will not be sent again.", a);
        return (rowCount ?? 0) > 0 ? txId : null;
      } catch (error) {
        await client.query("ROLLBACK");
        if (!error || typeof error !== "object") throw error;
        const pgError = error as { code?: unknown; constraint?: unknown };
        if (pgError.code !== "23505" || pgError.constraint !== "payment_intents_transaction_id_idx") throw error;
      } finally {
        client.release();
      }
    }
    throw new Error("Could not allocate a unique TheTeller transaction ID");
  }

  async function startPaytellerCheckout(
    userId: string, accountId: string, amount: number, key: string, res: Response, attempt: DepositAttempt
  ): Promise<void> {
    const site = siteUrl();
    const config = loadPaytellerConfig(process.env);
    const network = typeof attempt.network === "string" ? attempt.network : null;
    const intent = await openIntent(userId, amount, key, `${site}/wallet.html`, res, attempt, network, "payteller");
    if (!intent) return;
    if (intent.gateway !== "payteller") {
      return reject(res, 409, "payment_provider_changed", "This payment was already started with another provider. Check your deposit history.", attempt);
    }
    if (intent.transactionId && intent.checkoutUrl && intent.status === "PENDING") {
      res.json({
        checkout_url: intent.checkoutUrl,
        transaction_id: intent.transactionId,
        reference: depositReference(intent.transactionId),
        status: clientStatus(intent.status),
      });
      return;
    }
    if (intent.status !== "PENDING") {
      return reject(res, 409, "already_processed", "This payment was already processed. Please start a new deposit.", attempt);
    }

    if (intent.transactionId) {
      return reject(res, 409, "payment_pending", "This payment has already started. Check deposit history; it will not be sent again.", attempt);
    }
    const txId = await claimTxId(intent.id, userId, res, attempt);
    if (!txId) return;
    const reference = depositReference(txId);
    console.log("[payment/security] %s", JSON.stringify({ event: "gateway_creation_claimed", user_id: userId, amount, reference, ...attempt.context }));

    try {
      const { checkoutUrl } = await createPaytellerPayment(config, {
        amountMajor: amount,
        reference,
        customerEmail: checkoutEmail(accountId, new URL(site).hostname),
        description: `Casino deposit ${reference}`,
        returnUrl: `${site}/wallet.html`,
      });
      await db.query(`UPDATE payment_intents SET checkout_url = $1, updated_at = now() WHERE id = $2`, [checkoutUrl, intent.id]);
      res.status(201).json({ checkout_url: checkoutUrl, transaction_id: txId, reference, status: "pending" });
    } catch (error) {
      if (!(error instanceof PaytellerRequestError)) throw error;
      const message = error.message.slice(0, 500);
      if (error.declined) {
        await db.query(
          `UPDATE payment_intents SET status = 'FAILED', gateway_note = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
          [intent.id, message]
        );
      } else {
        await noteIntent(db, txId, message);
      }
      console.error("[payteller/checkout] %s %s: %s", reference, error.declined ? "rejected" : "outcome uncertain", message);
      res.status(502).json({
        error: error.declined ? "gateway_error" : "payment_pending",
        message: error.declined
          ? message
          : "Payteller did not confirm checkout creation. Check your deposit history before trying again.",
        transaction_id: txId,
        reference,
      });
    }
  }

  router.get("/config", async (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    let on: boolean;
    try {
      on = await paymentsEnabled(db);
    } catch (e) {
      next(e);
      return;
    }
    /* the site's pages read paymentsOn to show the "temporarily unavailable" notice, and the live minimum deposit
       and the betting and withdrawal rules (deposit page, withdraw page, terms) */
    let rules;
    try {
      rules = publicRules(await getMoneyRules(db));
    } catch (e) {
      next(e);
      return;
    }
    const sw = { paymentsOn: on, ...(on ? {} : { message: PAYMENTS_OFF_MESSAGE }), minDeposit: rules.min_deposit, maxDeposit: rules.max_deposit, rules };
    try {
      const config = loadPaytellerConfig(process.env);
      res.json({
        ...sw,
        enabled: true,
        provider: "payteller",
        baseUrl: config.apiBaseUrl,
        merchantIdLooksValid: /^TTM-\d{8}$/.test(config.merchantId),
        commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      });
    } catch (error) {
      if (error instanceof PaytellerConfigurationError) {
        res.json({ ...sw, enabled: false, provider: "payteller", reason: error.message });
        return;
      }
      throw error;
    }
  });

  /* The deposit page's "Before you deposit" box: the current rules, and whether this player has accepted them. */
  router.get("/rules", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const rules = await getMoneyRules(db);
      res.setHeader("Cache-Control", "no-store");
      res.json({ rules: publicRules(rules), accepted: await hasAcceptedRules(db, user.id, rules.rules_version), funds: await fundsOf(db, user.id) });
    } catch (error) {
      next(error);
    }
  });

  /* The player ticked "I have read and accept…": records acceptance of the version the page showed (a page showing
     an older version is told to read the new rules first). Body: { rules_version, idempotency_key }. */
  router.post("/accept-rules", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { rules_version } = (req.body ?? {}) as Record<string, unknown>;
      const accepted = await acceptRules(db, user.id, rules_version);
      res.setHeader("Cache-Control", "no-store");
      res.json({ accepted: true, ...accepted, rules: publicRules(await getMoneyRules(db)) });
    } catch (error) {
      if (error instanceof MoneyRuleError) {
        res.status(error.status).json({ error: error.code, message: error.message, rules: publicRules(await getMoneyRules(db, true)) });
        return;
      }
      next(error);
    }
  });

  /* The deposit page: the registered number, whether it's confirmed, and the wait left after the last successful deposit. */
  router.get("/deposit-status", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      res.setHeader("Cache-Control", "no-store");
      res.json(await depositState(db, user.id, user.phone));
    } catch (error) {
      next(error);
    }
  });

  /* "CONFIRM & LOCK NUMBER": saved once; the number is always the one registered, never one sent by the page. */
  router.post("/confirm-phone", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { phone } = (req.body ?? {}) as Record<string, unknown>;
      await confirmDepositPhone(db, user.id, user.phone, phone);
      res.setHeader("Cache-Control", "no-store");
      res.json(await depositState(db, user.id, user.phone));
    } catch (error) {
      if (error instanceof DepositGuardError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  /* Payteller hosted checkout; payment is settled only after Payteller's authenticated status confirms it. */
  router.post("/teller/checkout", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { amount, currency, idempotency_key } = (req.body ?? {}) as Record<string, unknown>;
      const attempt: DepositAttempt = { userId: user.id, method: "checkout", amount, currency, key: idempotency_key,
        context: initiationContext(req, user.accountId) };
      /* every check runs before TheTeller is contacted; a refused request is recorded and never sent */
      if (await refuseWhenOff(res, attempt)) return;
      if (await partnerDepositsOff(db, user.id)) {
        return reject(res, 403, "feature_off", "Deposits are switched off for your partner account. Contact support.", attempt);
      }
      const amt = await depositAmount(amount, res, attempt);
      if (amt === null) return;
      if (currency !== "GHS") return reject(res, 400, "unsupported_currency", "Only GHS deposits are supported", attempt);
      if (typeof idempotency_key !== "string" || !idempotency_key.trim() || idempotency_key.length > 120) {
        return reject(res, 400, "invalid_idempotency_key", "A 1-120 character idempotency_key is required", attempt);
      }
      if (!(await lockedNumber(db, user.id)).confirmed) {
        return reject(res, 409, "phone_not_confirmed", PHONE_NOT_CONFIRMED_MESSAGE, attempt);
      }

      await startPaytellerCheckout(user.id, user.accountId, amt, idempotency_key.trim(), res, attempt);
    } catch (error) {
      next(error);
    }
  });

  /* Legacy route for the deposit page. Payteller handles payment-method selection in hosted checkout. */
  router.post("/teller/momo", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { amount, currency, idempotency_key, account_number, network } = (req.body ?? {}) as Record<string, unknown>;
      const attempt: DepositAttempt = { userId: user.id, method: "momo", amount, currency, network, phone: account_number, key: idempotency_key,
        context: initiationContext(req, user.accountId) };
      /* every check runs before TheTeller is contacted; a refused request is recorded and never sent */
      if (await refuseWhenOff(res, attempt)) return;
      if (await partnerDepositsOff(db, user.id)) {
        return reject(res, 403, "feature_off", "Deposits are switched off for your partner account. Contact support.", attempt);
      }
      const amt = await depositAmount(amount, res, attempt);
      if (amt === null) return;
      if (currency !== "GHS") return reject(res, 400, "unsupported_currency", "Only GHS deposits are supported", attempt);
      if (typeof idempotency_key !== "string" || !idempotency_key.trim() || idempotency_key.length > 120) {
        return reject(res, 400, "invalid_idempotency_key", "A 1-120 character idempotency_key is required", attempt);
      }
      /* only the registered number may pay: a number sent by the page is just checked against it, never used */
      if (account_number !== undefined && account_number !== null && account_number !== "") {
        const sent = canonicalTellerSubscriberNumber(account_number);
        if (!sent) return reject(res, 400, "invalid_account", "Enter a valid Ghanaian mobile money number", attempt);
        if (localNumber(user.phone) !== "0" + sent.slice(3)) {
          return reject(res, 403, "phone_not_registered", "Deposits can only be made from the phone number registered to your account.", attempt);
        }
      }
      if (network !== undefined && network !== null && network !== "" && !NETWORKS.includes(network as MomoNetwork)) {
        return reject(res, 400, "invalid_network", "Choose MTN, Telecel or AirtelTigo", attempt);
      }
      let target: Awaited<ReturnType<typeof checkRegisteredNumber>>;
      try {
        target = await checkRegisteredNumber(db, user.id, user.phone);
      } catch (e) {
        if (!(e instanceof DepositGuardError)) throw e;
        return reject(res, e.status, e.code, e.message, attempt, e.extra);
      }
      attempt.phone = target.local;
      attempt.network = network ?? target.network;
      await startPaytellerCheckout(user.id, user.accountId, amt, idempotency_key.trim(), res, attempt);
    } catch (error) {
      next(error);
    }
  });

  /* The browser polls this. Only the owner can see a transaction; its original provider is checked until it settles. */
  router.get("/teller/status/:id", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const txId = String(req.params.id ?? "");
      const { rows } = await db.query<{ user_id: string; status: string; updated_at: Date; gateway: "teller" | "payteller" }>(
        `SELECT user_id, status, updated_at, gateway FROM payment_intents WHERE transaction_id = $1`,
        [txId]
      );
      const local = rows[0];
      if (!local || local.user_id !== user.id) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const answer = async (status: string) => {
        const row = await db.query<{ gateway_note: string | null; amount: string }>(
          `SELECT gateway_note, amount FROM payment_intents WHERE transaction_id = $1`, [txId]);
        res.json({
          transaction_id: txId,
          reference: depositReference(txId),
          status,
          amount: Number(row.rows[0]?.amount ?? 0),
          reason: status === "approved" ? null : row.rows[0]?.gateway_note ?? null,
        });
      };
      if (local.status === "CONFIRMED" || local.status === "REVERSED") return await answer(clientStatus(local.status));
      if (momoWaiting.has(txId)) return await answer("pending");
      // A recent failure is rechecked once more in case the provider reported a late approval.
      const recentFailure = local.status === "FAILED" && Date.now() - new Date(local.updated_at).getTime() < 6 * 3600 * 1000;
      if (local.status !== "PENDING" && !recentFailure) return await answer(clientStatus(local.status));

      try {
        let v: "approved" | "declined" | null;
        let amount: number | null;
        let reason: string;
        if (local.gateway === "payteller") {
          const remote = await checkPaytellerPayment(loadPaytellerConfig(process.env), depositReference(txId));
          v = paytellerVerdict(remote.status);
          amount = paytellerPaidPesewas(remote.amount);
          reason = typeof remote.error === "string" ? remote.error : "";
        } else {
          const remote = await checkTellerStatus(loadTellerConfig(process.env), txId);
          v = verdict(remote);
          amount = paidPesewas(remote.amount);
          reason = reasonText(remote.reason ?? remote.description);
        }
        if (v === "approved" && local.status === "FAILED") await reopenFailedIntent(db, txId);
        if (v && (local.status === "PENDING" || v === "approved")) {
          await settleIntent(db, txId, v, amount, reason);
        } else if (!v && local.status === "PENDING") {
          await noteIntent(db, txId, reason);
        }
      } catch (err) {
        if (err instanceof TellerConfigurationError || err instanceof PaytellerConfigurationError) throw err;
        console.error("[%s/status] %s check failed: %s", local.gateway, txId, (err as Error).message);
        await noteIntent(db, txId, `Check failed: ${(err as Error).message}`).catch(() => undefined);
      }
      const after = await db.query<{ status: string }>(`SELECT status FROM payment_intents WHERE transaction_id = $1`, [txId]);
      await answer(clientStatus(after.rows[0]?.status ?? "PENDING"));
    } catch (error) {
      next(error);
    }
  });

  /* The signed-in player's recent deposits, newest first, with TheTeller's message for anything not credited. */
  router.get("/teller/deposits", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { rows } = await db.query<{
        transaction_id: string; amount: string; status: string; gateway_note: string | null; created_at: Date;
      }>(
        `SELECT transaction_id, amount, status, gateway_note, created_at FROM payment_intents
          WHERE user_id = $1 AND transaction_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 20`,
        [user.id]
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({
        deposits: rows.map((r) => ({
          transaction_id: r.transaction_id,
          reference: depositReference(r.transaction_id),
          amount: Number(r.amount),
          status: clientStatus(r.status),
          reason: r.status === "CONFIRMED" ? null : r.gateway_note,
          created_at: r.created_at,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /* Older checkouts were sent back here; forward them to the wallet page, which polls the status route. */
  router.get("/teller/return", (req: Request, res: Response) => {
    const id = typeof req.query.transaction_id === "string" ? req.query.transaction_id : "";
    res.redirect(302, `${siteUrl()}/wallet.html${/^\d{12}$/.test(id) ? `?transaction_id=${id}` : ""}`);
  });

  return router;
}

/** Every minute, asks each payment's original provider about pending deposits, including ones left after checkout. */
export function startPendingRecheck(db: Pool): void {
  const run = async () => {
    try {
      const { rows } = await db.query<{ transaction_id: string; gateway: "teller" | "payteller"; status: "PENDING" | "FAILED" }>(
        `SELECT transaction_id, gateway, status FROM payment_intents
          WHERE transaction_id IS NOT NULL
            AND (status = 'PENDING' OR (status = 'FAILED' AND updated_at > now() - interval '6 hours'))
            AND created_at < now() - interval '20 seconds'
            AND created_at > now() - interval '24 hours'
          ORDER BY created_at LIMIT 50`
      );
      for (const { transaction_id: txId, gateway, status } of rows) {
        if (momoWaiting.has(txId)) continue;
        try {
          if (gateway === "payteller") {
            const remote = await checkPaytellerPayment(loadPaytellerConfig(process.env), depositReference(txId));
            const v = paytellerVerdict(remote.status);
            const note = typeof remote.error === "string" ? remote.error : "";
            if (v === "approved") {
              if (status === "FAILED") await reopenFailedIntent(db, txId);
              await settleIntent(db, txId, "approved", paytellerPaidPesewas(remote.amount), note);
            } else if (v === "declined" && status === "PENDING") {
              await settleIntent(db, txId, "declined", paytellerPaidPesewas(remote.amount), note);
            } else if (!v && note) {
              await noteIntent(db, txId, note);
            }
          } else {
            const remote = await checkTellerStatus(loadTellerConfig(process.env), txId);
            const v = verdict(remote);
            const note = reasonText(remote.reason ?? remote.description);
            if (v === "approved") {
              if (status === "FAILED") await reopenFailedIntent(db, txId);
              await settleIntent(db, txId, "approved", paidPesewas(remote.amount), note);
            } else if (v === "declined" && status === "PENDING") {
              await settleIntent(db, txId, "declined", paidPesewas(remote.amount), note);
            } else if (!v && note) {
              await noteIntent(db, txId, note);
            }
          }
        } catch (err) {
          console.error("[%s/recheck] %s: %s", gateway, txId, (err as Error).message);
          await noteIntent(db, txId, `Check failed: ${(err as Error).message}`).catch(() => undefined);
        }
      }
    } catch (err) {
      console.error("[teller/recheck] query failed: %s", (err as Error).message);
    }
  };
  setInterval(run, 60 * 1000).unref();
}
