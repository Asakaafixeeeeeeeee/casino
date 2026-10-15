import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
import {
  checkTellerStatus,
  createPaymentIntent,
  credentialHints,
  initiateTellerCheckout,
  loadTellerConfig,
  newTxId,
  paidPesewas,
  reasonText,
  requestMomoPayment,
  TellerConfigurationError,
  TellerRequestError,
  depositReference,
  verdict,
  type MomoNetwork,
} from "../services/teller.js";
import { noteIntent, reopenFailedIntent, settleIntent } from "../services/tellerSettlement.js";
import { checkDeposit, LimitError } from "../services/responsibleGaming.js";
import { partnerOf } from "../services/affiliates.js";
import { permissionsOf } from "../services/partnerPlatform.js";
import { PAYMENTS_OFF_MESSAGE, paymentsEnabled } from "../services/paymentSettings.js";
import {
  acceptRules, amountText, fundsOf, getMoneyRules, hasAcceptedRules, MAX_DEPOSIT, MoneyRuleError, publicRules,
} from "../services/moneyRules.js";

/* the minimum deposit is the admin's live setting (Admin -> Betting & withdrawal settings; GHS 135 by default) */
export const RULES_NOT_ACCEPTED_MESSAGE =
  "Before depositing, please read and accept the deposit, betting and withdrawal rules shown on the deposit page.";
const NETWORKS: readonly MomoNetwork[] = ["MTN", "VDF", "ATL", "TGO"];

// Momo prompts TheTeller hasn't answered yet; the status route reports these as pending without asking.
// In memory only: after a restart the status check and the background recheck take over.
const momoWaiting = new Set<string>();

function siteUrl(): string {
  return (process.env.SITE_URL ?? process.env.PUBLIC_URL ?? "http://localhost:8000").replace(/\/+$/, "");
}

function readAmount(raw: unknown, min: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > MAX_DEPOSIT) return null;
  return Math.round(n * 100) / 100;
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
interface DepositAttempt { userId: string; method: "momo" | "checkout"; amount: unknown; currency: unknown; network?: unknown; phone?: unknown; key: unknown }

export function paymentsRouter(db: Pool): Router {
  const router = Router();

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

  /* The main admin's TheTeller switch (Admin -> TheTeller Payment Settings): while it's OFF no new payment can start.
     Only the routes that start a payment ask; checking and crediting payments already started never does. */
  async function refuseWhenOff(res: Response, a: DepositAttempt): Promise<boolean> {
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
  /* no deposit until the player has accepted the current deposit, betting and withdrawal rules */
  async function refuseUntilAccepted(userId: string, res: Response, a: DepositAttempt): Promise<boolean> {
    const rules = await getMoneyRules(db);
    if (await hasAcceptedRules(db, userId, rules.rules_version)) return false;
    await reject(res, 409, "rules_not_accepted", RULES_NOT_ACCEPTED_MESSAGE, a, { rules_version: rules.rules_version });
    return true;
  }

  /* deposit limits and breaks are enforced here, whatever the page shows */
  /* A new deposit's checks and its intent, under one per-player lock: deposits started at once can no longer all pass
     a limit only one of them fits (each now sees the others), and no player can have more than MAX_OPEN_PROMPTS
     payments waiting at once (a PIN prompt goes to whatever number is given). A retried key returns its intent. */
  const MAX_OPEN_PROMPTS = 3;
  async function openIntent(userId: string, amount: number, key: string, redirectUrl: string, res: Response, a: DepositAttempt, network: string | null = null) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["deposit:" + userId]);
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
          `SELECT count(*)::int AS n FROM payment_intents WHERE user_id = $1 AND status = 'PENDING' AND created_at > now() - interval '10 minutes'`, [userId]);
        if (open.rows[0]!.n >= MAX_OPEN_PROMPTS) {
          await client.query("ROLLBACK");
          await reject(res, 429, "too_many_pending", "You have payments still waiting for approval. Approve or wait for them before starting another.", a);
          return null;
        }
      }
      const intent = await createPaymentIntent(client, userId, amount, "GHS", key, redirectUrl, network);
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
  /* the transaction id is set once: a retry racing the first request can't start a second, untracked charge */
  async function claimTxId(intentId: string, txId: string, payerPhone: string | null): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE payment_intents SET transaction_id = $1, payer_phone = COALESCE($3, payer_phone), updated_at = now()
        WHERE id = $2 AND transaction_id IS NULL`, [txId, intentId, payerPhone]);
    return (rowCount ?? 0) > 0;
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
      const config = loadTellerConfig(process.env);
      res.json({
        ...sw,
        enabled: true,
        provider: "teller",
        baseUrl: config.apiBaseUrl,
        checkoutUrl: config.checkoutBaseUrl,
        ...credentialHints(process.env),
        commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      });
    } catch (error) {
      if (error instanceof TellerConfigurationError) {
        res.json({ ...sw, enabled: false, provider: "teller", reason: error.message });
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

  /* Hosted checkout: the customer pays on TheTeller's page and comes back to wallet.html?transaction_id=… */
  router.post("/teller/checkout", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { amount, currency, idempotency_key } = (req.body ?? {}) as Record<string, unknown>;
      const attempt: DepositAttempt = { userId: user.id, method: "checkout", amount, currency, key: idempotency_key };
      /* every check runs before TheTeller is contacted; a refused request is recorded and never sent */
      if (await refuseWhenOff(res, attempt)) return;
      if (await partnerDepositsOff(db, user.id)) {
        return reject(res, 403, "feature_off", "Deposits are switched off for your partner account. Contact support.", attempt);
      }
      const amt = await depositAmount(amount, res, attempt);
      if (amt === null) return;
      if (currency !== "GHS") return reject(res, 400, "unsupported_currency", "Only GHS deposits are supported", attempt);
      if (typeof idempotency_key !== "string" || !idempotency_key.trim()) {
        return reject(res, 400, "invalid_idempotency_key", "A non-empty idempotency_key is required", attempt);
      }
      if (await refuseUntilAccepted(user.id, res, attempt)) return;

      const config = loadTellerConfig(process.env);
      const site = siteUrl();
      // Only ever send the customer back to our own site; a client-supplied redirect is ignored.
      const redirectUrl = `${site}/wallet.html`;

      const intent = await openIntent(user.id, amt, idempotency_key, redirectUrl, res, attempt);
      if (!intent) return;
      if (intent.transactionId && intent.checkoutUrl) {
        res.json({ checkout_url: intent.checkoutUrl, transaction_id: intent.transactionId, reference: depositReference(intent.transactionId),
          status: clientStatus(intent.status) });
        return;
      }
      /* a duplicate of a request already sent: never a second call to TheTeller */
      if (intent.transactionId || intent.status !== "PENDING") {
        return reject(res, 409, "already_processed", "This payment was already started. Please try again.", attempt);
      }

      // Saved before TheTeller is called, so a crash can never lose track of a payment.
      const txId = newTxId();
      if (!(await claimTxId(intent.id, txId, null))) {
        return reject(res, 409, "already_processed", "This payment was already started. Please try again.", attempt);
      }
      console.log("[teller/checkout] user=%s amount=%s tx=%s", user.id, amt, txId);

      try {
        const { checkoutUrl } = await initiateTellerCheckout(config, {
          transactionId: txId,
          amountMajor: amt,
          redirectUrl,
          email: `${user.accountId}@${new URL(site).hostname}`,
          desc: depositReference(txId),
        });
        await db.query(`UPDATE payment_intents SET checkout_url = $1, updated_at = now() WHERE id = $2`, [checkoutUrl, intent.id]);
        res.status(201).json({ checkout_url: checkoutUrl, transaction_id: txId, reference: depositReference(txId), status: "pending" });
      } catch (err) {
        // No checkout page was handed out, so no money can have moved.
        await db.query(
          `UPDATE payment_intents SET status = 'FAILED', gateway_note = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
          [intent.id, (err as Error).message || null]
        );
        console.error("[teller/checkout] %s failed: %s", txId, (err as Error).message);
        res.status(502).json({ error: "gateway_error", message: (err as Error).message || "The payment provider refused the request" });
      }
    } catch (error) {
      next(error);
    }
  });

  /* Direct mobile money: TheTeller pushes a PIN prompt to the phone. We answer at once and settle in the background. */
  router.post("/teller/momo", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { amount, currency, idempotency_key, account_number, network } = (req.body ?? {}) as Record<string, unknown>;
      const attempt: DepositAttempt = { userId: user.id, method: "momo", amount, currency, network, phone: account_number, key: idempotency_key };
      /* every check runs before TheTeller is contacted; a refused request is recorded and never sent */
      if (await refuseWhenOff(res, attempt)) return;
      if (await partnerDepositsOff(db, user.id)) {
        return reject(res, 403, "feature_off", "Deposits are switched off for your partner account. Contact support.", attempt);
      }
      const amt = await depositAmount(amount, res, attempt);
      if (amt === null) return;
      if (currency !== "GHS") return reject(res, 400, "unsupported_currency", "Only GHS deposits are supported", attempt);
      if (typeof idempotency_key !== "string" || !idempotency_key.trim()) {
        return reject(res, 400, "invalid_idempotency_key", "A non-empty idempotency_key is required", attempt);
      }
      const subscriber = String(account_number ?? "").replace(/\D/g, "");
      if (!/^233[235]\d{8}$/.test(subscriber)) return reject(res, 400, "invalid_account", "Enter a valid Ghanaian mobile money number", attempt);
      if (!NETWORKS.includes(network as MomoNetwork)) return reject(res, 400, "invalid_network", "Choose MTN, Telecel or AirtelTigo", attempt);
      if (await refuseUntilAccepted(user.id, res, attempt)) return;
      const config = loadTellerConfig(process.env);
      const intent = await openIntent(user.id, amt, idempotency_key, `${siteUrl()}/wallet.html`, res, attempt, network as string);
      if (!intent) return;
      if (intent.transactionId) {
        res.json({ transaction_id: intent.transactionId, reference: depositReference(intent.transactionId), status: clientStatus(intent.status) });
        return;
      }

      const txId = newTxId();
      /* the number paying: any mobile money wallet may fund a deposit (winnings only ever go to the registered one) */
      if (!(await claimTxId(intent.id, txId, "0" + subscriber.slice(3)))) {
        const now = (await db.query<{ transaction_id: string; status: string }>(
          `SELECT transaction_id, status FROM payment_intents WHERE id = $1`, [intent.id])).rows[0]!;
        res.json({ transaction_id: now.transaction_id, reference: depositReference(now.transaction_id), status: clientStatus(now.status) });
        return;
      }
      console.log("[teller/momo] user=%s amount=%s network=%s tx=%s", user.id, amt, network, txId);

      momoWaiting.add(txId);
      requestMomoPayment(config, {
        transactionId: txId,
        amountMajor: amt,
        subscriberNumber: subscriber,
        network: network as MomoNetwork,
        desc: depositReference(txId),
      })
        .then(async (data) => {
          await settleIntent(db, txId, "approved", paidPesewas(data.amount));
        })
        .catch(async (err: unknown) => {
          const message = (err as Error).message || "";
          if (err instanceof TellerRequestError && err.declined) {
            await settleIntent(db, txId, "declined", null, message);
            return;
          }
          console.error("[teller/momo] %s left pending: %s", txId, message); // a status check decides later
          await noteIntent(db, txId, message);
        })
        .catch(async (err: unknown) => {
          console.error("[teller/momo] %s settle failed", txId, err);
          await noteIntent(db, txId, `Could not credit: ${(err as Error).message}`).catch(() => undefined);
        })
        .finally(() => momoWaiting.delete(txId));

      res.status(202).json({ transaction_id: txId, reference: depositReference(txId), status: "pending" });
    } catch (error) {
      next(error);
    }
  });

  /* The browser polls this. Only the owner can see a transaction; TheTeller is asked while it's undecided. */
  router.get("/teller/status/:id", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const txId = String(req.params.id ?? "");
      const { rows } = await db.query<{ user_id: string; status: string; updated_at: Date }>(
        `SELECT user_id, status, updated_at FROM payment_intents WHERE transaction_id = $1`,
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
      // A recent failure is rechecked once more, in case TheTeller approved it late.
      const recentFailure = local.status === "FAILED" && Date.now() - new Date(local.updated_at).getTime() < 6 * 3600 * 1000;
      if (local.status !== "PENDING" && !recentFailure) return await answer(clientStatus(local.status));

      try {
        const config = loadTellerConfig(process.env);
        const remote = await checkTellerStatus(config, txId);
        const v = verdict(remote);
        const reason = reasonText(remote.reason ?? remote.description);
        if (v === "approved" && local.status === "FAILED") await reopenFailedIntent(db, txId);
        if (v && (local.status === "PENDING" || v === "approved")) {
          await settleIntent(db, txId, v, paidPesewas(remote.amount), reason);
        } else if (!v && local.status === "PENDING") {
          await noteIntent(db, txId, reason);
        }
      } catch (err) {
        if (err instanceof TellerConfigurationError) throw err;
        console.error("[teller/status] %s check failed: %s", txId, (err as Error).message); // never a decline
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

/** Every minute, asks TheTeller about deposits still pending from the last 6 hours, so a payment the player
 *  confirmed after leaving the deposit screen is credited within about a minute (late confirmations). */
export function startPendingRecheck(db: Pool): void {
  const run = async () => {
    let config;
    try {
      config = loadTellerConfig(process.env);
    } catch {
      return;
    }
    try {
      const { rows } = await db.query<{ transaction_id: string }>(
        `SELECT transaction_id FROM payment_intents
          WHERE status = 'PENDING' AND transaction_id IS NOT NULL
            AND created_at < now() - interval '45 seconds'
            AND created_at > now() - interval '6 hours'
          ORDER BY created_at LIMIT 50`
      );
      for (const { transaction_id: txId } of rows) {
        if (momoWaiting.has(txId)) continue;
        try {
          const remote = await checkTellerStatus(config, txId);
          const v = verdict(remote);
          if (v) await settleIntent(db, txId, v, paidPesewas(remote.amount), reasonText(remote.reason ?? remote.description));
        } catch (err) {
          console.error("[teller/recheck] %s: %s", txId, (err as Error).message);
          await noteIntent(db, txId, `Check failed: ${(err as Error).message}`).catch(() => undefined);
        }
      }
    } catch (err) {
      console.error("[teller/recheck] query failed: %s", (err as Error).message);
    }
  };
  setInterval(run, 60 * 1000).unref();
}
