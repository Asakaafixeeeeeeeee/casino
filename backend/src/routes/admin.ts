import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { authenticate, requireAdmin, requireUser } from "../middleware/authenticate.js";
import { loadTellerConfig, TellerConfigurationError } from "../services/teller.js";
import {
  listWithdrawals,
  payWithdrawal,
  recheckWithdrawal,
  rejectWithdrawal,
  WithdrawalError,
} from "../services/withdrawals.js";
import {
  AdminError, adjustBalance, auditLog, catalogAdmin, creditByPhone, lookupByPhone, overview, searchUsers, setCatalog,
  setUserKyc, setUserStatus, transactions, userDetail,
} from "../services/admin.js";
import {
  correctCommission, decidePartnerPayout, deductionHistory, getSettings, listPartnerPayouts, listPartners, lookupPlayer, PartnerError,
  partnerDetail, partnerPreview, programmeStats, saveSettings, settleCommissions, updatePartner,
} from "../services/affiliates.js";
import { adminReply, adminThread, adminThreads, setThreadStatus, SupportError, unreadThreads } from "../services/support.js";
import { listAdminMinesSignals } from "../services/minesSignal.js";
import { DepositError, recheckDeposit, waitingDeposits } from "../services/depositRecheck.js";
import { aviatorOverview, saveAviatorSettings } from "../services/aviatorAdmin.js";
import {
  adminFlyers, createCampaign, createPartnerAccount, createTemplate, deleteAsset, deleteTemplate, globalPermissions, PERMISSIONS,
  permissionsOf, saveGlobalPermissions, savePartnerPermissions, saveTemplate, updateCampaign, uploadAsset,
} from "../services/partnerPlatform.js";
import { partnerOf } from "../services/affiliates.js";
import { cancelInvite, createInvite, listInvites, renewInvite } from "../services/partnerInvites.js";

const STATUSES = ["REQUESTED", "PAYING", "PAID", "DECLINED"];

/** Back office for the accounts listed in ADMIN_PHONES: the dashboard's numbers, players, the money feed, games and
 *  studios, partners, and withdrawals. Every change an admin makes is written to admin_actions. */
export function adminRouter(db: Pool): Router {
  const r = Router();
  r.use(authenticate, requireAdmin);

  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await fn(req, res);
      } catch (e) {
        if (e instanceof WithdrawalError || e instanceof AdminError || e instanceof PartnerError || e instanceof SupportError) {
          res.status(e.status).json({ error: e.code, message: e.message });
          return;
        }
        if (e instanceof TellerConfigurationError) {
          res.status(503).json({ error: "payouts_disabled", message: e.message });
          return;
        }
        next(e);
      }
    };

  r.get("/me", handle(async (_req, res) => {
    /* withdrawals are paid by hand and approved here, so approving never depends on TheTeller */
    const payouts = true;
    /* what's waiting for an admin, for the tab badges */
    const { rows } = await db.query(
      `SELECT (SELECT count(*) FROM withdrawals WHERE status = 'REQUESTED') AS withdrawals,
              (SELECT count(*) FROM affiliates WHERE status = 'PENDING') AS partners,
              (SELECT count(*) FROM affiliate_payouts WHERE status IN ('REQUESTED', 'APPROVED')) AS partner_payouts`);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      admin: true, payoutsEnabled: payouts, phone: requireUser(_req).phone,
      waiting: {
        withdrawals: Number(rows[0].withdrawals), partners: Number(rows[0].partners), partnerPayouts: Number(rows[0].partner_payouts),
        support: await unreadThreads(db),
      },
    });
  }));

  /* JSON answers that must never be cached */
  const send = (fn: (req: Request) => Promise<unknown>) => handle(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await fn(req));
  });
  const adminOf = (req: Request) => requireUser(req).phone;
  const query = (req: Request) => req.query as Record<string, unknown>;

  /* the dashboard */
  r.get("/overview", send((req) => overview(db, String(req.query.range ?? "today"))));
  r.get("/transactions", send((req) => transactions(db, query(req))));
  r.get("/actions", send((req) => auditLog(db, query(req))));
  r.get("/mines/signals", send(() => listAdminMinesSignals(db)));

  /* Aviator: live monitor (a round's crash point only once it's over), published RTP and bet limits */
  r.get("/aviator", send(() => aviatorOverview(db)));
  r.post("/aviator/settings", send((req) => saveAviatorSettings(db, adminOf(req), req.body ?? {})));

  /* players */
  r.get("/users", send((req) => searchUsers(db, query(req))));
  r.get("/users/:id", send((req) => userDetail(db, req.params.id)));
  r.post("/users/:id/status", send((req) => setUserStatus(db, adminOf(req), req.params.id, req.body ?? {})));
  r.post("/users/:id/kyc", send((req) => setUserKyc(db, adminOf(req), req.params.id, req.body ?? {})));
  r.post("/users/:id/adjust", send((req) => adjustBalance(db, adminOf(req), req.params.id, req.body ?? {})));

  /* add money to a player by mobile number (the dashboard's "Add money" card) */
  r.get("/credit/lookup", send((req) => lookupByPhone(db, req.query.phone)));
  r.post("/credit", send((req) => creditByPhone(db, adminOf(req), req.body ?? {})));

  /* games and studios */
  r.get("/catalog", send((req) => catalogAdmin(db, String(req.query.range ?? "30d"))));
  r.post("/catalog/:kind/:id", send((req) => setCatalog(db, adminOf(req), req.params.kind, req.params.id, req.body ?? {})));

  /* partners: the programme's settings and numbers, find a player to add, each partner, and payout requests */
  r.get("/partner-settings", send(async () => ({ settings: await getSettings(db), deductionHistory: await deductionHistory(db) })));
  r.post("/partner-settings", send((req) => saveSettings(db, adminOf(req), req.body ?? {})));
  r.post("/partner-settings/settle", send(() => settleCommissions(db)));
  r.get("/partner-stats", send((req) => programmeStats(db, query(req))));
  r.get("/partner-lookup", send((req) => lookupPlayer(db, query(req))));
  /* a partner who has never registered: their sign-in account, wallet and partner account in one go */
  r.post("/partners/create", send((req) => createPartnerAccount(db, adminOf(req), req.body ?? {})));
  /* partner setup links: the admin enters a number, commission and switches; the partner registers through the link */
  r.get("/partner-invites", send(() => listInvites(db)));
  r.post("/partner-invites", send((req) => createInvite(db, adminOf(req), req.body ?? {})));
  r.post("/partner-invites/:id/renew", send((req) => renewInvite(db, adminOf(req), req.params.id)));
  r.post("/partner-invites/:id/cancel", send((req) => cancelInvite(db, adminOf(req), req.params.id)));
  /* feature switches: for every partner, and for one */
  r.get("/partner-permissions", send(async () => ({ permissions: await globalPermissions(db), list: PERMISSIONS.map(([key, label]) => ({ key, label })) })));
  r.post("/partner-permissions", send((req) => saveGlobalPermissions(db, adminOf(req), req.body?.permissions)));
  r.get("/partners/:id/permissions", send(async (req) => {
    const a = await partnerOf(db, String(req.params.id));
    if (!a) throw new PartnerError("not_found", "That partner wasn't found", 404);
    return { ...(await permissionsOf(db, a)), list: PERMISSIONS.map(([key, label]) => ({ key, label })) };
  }));
  r.post("/partners/:id/permissions", send((req) => savePartnerPermissions(db, adminOf(req), req.params.id, req.body?.permissions)));
  /* flyers: templates, campaigns and uploaded images */
  r.get("/flyers", send(() => adminFlyers(db)));
  r.post("/flyer-templates", send((req) => createTemplate(db, adminOf(req), req.body ?? {})));
  r.post("/flyer-templates/:id", send((req) => saveTemplate(db, adminOf(req), req.params.id, req.body ?? {})));
  r.post("/flyer-templates/:id/delete", send((req) => deleteTemplate(db, adminOf(req), req.params.id)));
  r.post("/flyer-campaigns", send((req) => createCampaign(db, adminOf(req), req.body ?? {})));
  r.post("/flyer-campaigns/:id", send((req) => updateCampaign(db, adminOf(req), req.params.id, req.body ?? {})));
  r.post("/flyer-assets", send((req) => uploadAsset(db, adminOf(req), req.body ?? {})));
  r.post("/flyer-assets/:id/delete", send((req) => deleteAsset(db, adminOf(req), req.params.id)));
  r.get("/partners", send((req) => listPartners(db, query(req))));
  r.get("/partners/:id", send((req) => partnerDetail(db, req.params.id)));
  /* the partner's own dashboard, read-only: summary, referrals, statistics, wallet, settings */
  r.get("/partners/:id/view/:view", send(async (req) => {
    const out = await partnerPreview(db, req.params.id, String(req.params.view), query(req));
    /* the preview shows the partner's portal with their own feature switches */
    if (req.params.view === "me") {
      const a = await partnerOf(db, String(req.params.id));
      if (a) return { ...out, permissions: (await permissionsOf(db, a)).effective, features: PERMISSIONS.map(([key, label]) => ({ key, label })) };
    }
    return out;
  }));
  r.post("/partners/:id", send((req) => updatePartner(db, adminOf(req), req.params.id, req.body ?? {})));
  r.post("/partners/:id/correction", send((req) => correctCommission(db, adminOf(req), req.params.id, req.body ?? {})));
  r.get("/partner-payouts", send((req) => listPartnerPayouts(db, query(req))));

  r.post("/partner-payouts/:id", send((req) => decidePartnerPayout(db, adminOf(req), req.params.id, req.body ?? {})));

  /* live support chat: the inbox, a conversation, a reply, close or reopen */
  r.get("/support", send((req) => adminThreads(db, query(req))));
  r.get("/support/:id", send((req) => adminThread(db, req.params.id, query(req))));
  r.post("/support/:id/messages", send((req) => adminReply(db, adminOf(req), req.params.id, req.body ?? {})));
  r.post("/support/:id/status", send((req) => setThreadStatus(db, adminOf(req), req.params.id, req.body ?? {})));

  r.get("/withdrawals", handle(async (req, res) => {
    const status = typeof req.query.status === "string" && STATUSES.includes(req.query.status) ? req.query.status : undefined;
    res.setHeader("Cache-Control", "no-store");
    res.json({ withdrawals: (await listWithdrawals(db, status)).map((w) => ({ ...w, amount: Number(w.amount) })) });
  }));

  r.post("/withdrawals/:id/pay", handle(async (req, res) => {
    const admin = requireUser(req);
    const result = await payWithdrawal(db, String(req.params.id), admin.phone);
    console.log("[admin] %s approved withdrawal %s (paid manually)", admin.phone, req.params.id);
    res.json(result);
  }));

  r.post("/withdrawals/:id/reject", handle(async (req, res) => {
    const admin = requireUser(req);
    const reason = String((req.body as { reason?: unknown })?.reason ?? "").trim().slice(0, 200);
    const w = await rejectWithdrawal(db, String(req.params.id), reason, admin.phone);
    console.log("[admin] %s rejected withdrawal %s: %s", admin.phone, req.params.id, reason);
    res.json({ status: w.status, note: w.gateway_note });
  }));

  /* deposits TheTeller hasn't settled, and a recheck for one (credits it at most once) */
  r.get("/deposits/waiting", send(() => waitingDeposits(db)));
  r.post("/deposits/:txId/recheck", handle(async (req, res) => {
    try {
      res.json(await recheckDeposit(db, loadTellerConfig(process.env), String(req.params.txId), requireUser(req).phone));
    } catch (e) {
      if (e instanceof DepositError) { res.status(e.status).json({ error: e.code, message: e.message }); return; }
      throw e;
    }
  }));

  r.post("/withdrawals/:id/recheck", handle(async (req, res) => {
    res.json(await recheckWithdrawal(db, loadTellerConfig(process.env), String(req.params.id)));
  }));

  return r;
}
