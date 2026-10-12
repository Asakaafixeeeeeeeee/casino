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

const MIN_DEPOSIT = 5;     // GHS; well under US$ 1 (the page shows the dollar figure)
const MAX_DEPOSIT = 50000;
const NETWORKS: readonly MomoNetwork[] = ["MTN", "VDF", "ATL", "TGO"];

// Momo prompts TheTeller hasn't answered yet; the status route reports these as pending without asking.
// In memory only: after a restart the status check and the background recheck take over.
const momoWaiting = new Set<string>();

function siteUrl(): string {
  return (process.env.SITE_URL ?? process.env.PUBLIC_URL ?? "http://localhost:8000").replace(/\/+$/, "");
}

function readAmount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_DEPOSIT || n > MAX_DEPOSIT) return null;
  return Math.round(n * 100) / 100;
}

function badRequest(res: Response, error: string, message: string): void {
  res.status(400).json({ error, message });
}

const clientStatus = (dbStatus: string) =>
  dbStatus === "CONFIRMED" ? "approved" : dbStatus === "PENDING" ? "pending" : "declined";

/** A partner whose deposits an admin switched off (players, and partners with deposits on, pay in as usual). */
async function partnerDepositsOff(db: Pool, userId: string): Promise<boolean> {
  const a = await partnerOf(db, userId);
  if (!a || a.status === "PENDING" || a.status === "REJECTED") return false;
  return !(await permissionsOf(db, a)).effective.wallet_deposits;
}

export function paymentsRouter(db: Pool): Router {
  const router = Router();

  /* deposit limits and breaks are enforced here, whatever the page shows */
  /* A new deposit's checks and its intent, under one per-player lock: deposits started at once can no longer all pass
     a limit only one of them fits (each now sees the others), and no player can have more than MAX_OPEN_PROMPTS
     payments waiting at once (a PIN prompt goes to whatever number is given). A retried key returns its intent. */
  const MAX_OPEN_PROMPTS = 3;
  async function openIntent(userId: string, amount: number, key: string, redirectUrl: string, res: Response, network: string | null = null) {
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
          res.status(e.status).json({ error: e.code, message: e.message });
          return null;
        }
        const open = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payment_intents WHERE user_id = $1 AND status = 'PENDING' AND created_at > now() - interval '10 minutes'`, [userId]);
        if (open.rows[0]!.n >= MAX_OPEN_PROMPTS) {
          await client.query("ROLLBACK");
          res.status(429).json({ error: "too_many_pending", message: "You have payments still waiting for approval. Approve or wait for them before starting another." });
          return null;
        }
      }
      const intent = await createPaymentIntent(client, userId, amount, "GHS", key, redirectUrl, network);
      await client.query("COMMIT");
      return intent;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (e instanceof TellerRequestError) {
        res.status(409).json({ error: "key_reused", message: e.message });
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

  router.get("/config", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const config = loadTellerConfig(process.env);
      res.json({
        enabled: true,
        provider: "teller",
        baseUrl: config.apiBaseUrl,
        checkoutUrl: config.checkoutBaseUrl,
        ...credentialHints(process.env),
        commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      });
    } catch (error) {
      if (error instanceof TellerConfigurationError) {
        res.json({ enabled: false, provider: "teller", reason: error.message });
        return;
      }
      throw error;
    }
  });

  /* Hosted checkout: the customer pays on TheTeller's page and comes back to wallet.html?transaction_id=… */
  router.post("/teller/checkout", authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      if (await partnerDepositsOff(db, user.id)) {
        res.status(403).json({ error: "feature_off", message: "Deposits are switched off for your partner account. Contact support." });
        return;
      }
      const { amount, currency, idempotency_key } = (req.body ?? {}) as Record<string, unknown>;
      const amt = readAmount(amount);
      if (amt === null) return badRequest(res, "invalid_amount", `Amount must be between GHS ${MIN_DEPOSIT} and GHS ${MAX_DEPOSIT}`);
      if (currency !== "GHS") return badRequest(res, "unsupported_currency", "Only GHS deposits are supported");
      if (typeof idempotency_key !== "string" || !idempotency_key.trim()) {
        return badRequest(res, "invalid_idempotency_key", "A non-empty idempotency_key is required");
      }

      const config = loadTellerConfig(process.env);
      const site = siteUrl();
      // Only ever send the customer back to our own site; a client-supplied redirect is ignored.
      const redirectUrl = `${site}/wallet.html`;

      const intent = await openIntent(user.id, amt, idempotency_key, redirectUrl, res);
      if (!intent) return;
      if (intent.transactionId && intent.checkoutUrl) {
        res.json({ checkout_url: intent.checkoutUrl, transaction_id: intent.transactionId, reference: depositReference(intent.transactionId),
          status: clientStatus(intent.status) });
        return;
      }
      if (intent.transactionId || intent.status !== "PENDING") {
        res.status(409).json({ error: "already_processed", message: "This payment was already started. Please try again." });
        return;
      }

      // Saved before TheTeller is called, so a crash can never lose track of a payment.
      const txId = newTxId();
      if (!(await claimTxId(intent.id, txId, null))) {
        res.status(409).json({ error: "already_processed", message: "This payment was already started. Please try again." });
        return;
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
      if (await partnerDepositsOff(db, user.id)) {
        res.status(403).json({ error: "feature_off", message: "Deposits are switched off for your partner account. Contact support." });
        return;
      }
      const { amount, currency, idempotency_key, account_number, network } = (req.body ?? {}) as Record<string, unknown>;
      const amt = readAmount(amount);
      if (amt === null) return badRequest(res, "invalid_amount", `Amount must be between GHS ${MIN_DEPOSIT} and GHS ${MAX_DEPOSIT}`);
      if (currency !== "GHS") return badRequest(res, "unsupported_currency", "Only GHS deposits are supported");
      if (typeof idempotency_key !== "string" || !idempotency_key.trim()) {
        return badRequest(res, "invalid_idempotency_key", "A non-empty idempotency_key is required");
      }
      const subscriber = String(account_number ?? "").replace(/\D/g, "");
      if (!/^233[235]\d{8}$/.test(subscriber)) return badRequest(res, "invalid_account", "Enter a valid Ghanaian mobile money number");
      if (!NETWORKS.includes(network as MomoNetwork)) return badRequest(res, "invalid_network", "Choose MTN, Telecel or AirtelTigo");
      const config = loadTellerConfig(process.env);
      const intent = await openIntent(user.id, amt, idempotency_key, `${siteUrl()}/wallet.html`, res, network as string);
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
