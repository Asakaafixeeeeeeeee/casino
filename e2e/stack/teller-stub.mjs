/* A stand-in for TheTeller (the payment gateway) and the exchange-rate feed, for the end-to-end suite.
   - POST /v1.1/transaction/process: a mobile money prompt. The "customer" answers after ~0.8 s: approved for any
     number, declined for a number ending 0000, and for a number ending 9999 the gateway never answers (the
     deposit stays pending and only a status check decides it). The approved amount is the amount requested.
   - GET  /v1.1/users/transactions/:id/status: the last verdict for that transaction, or pending.
   - GET  /fx: USD→GHS for conversions.  GET /health: liveness.
   - GET  /requests: every request seen, so a test can assert what the balance service sent. */
import http from "node:http";

const PORT = Number(process.env.PORT || 8796);
const verdicts = new Map();
const requests = [];

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://stub");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (url.pathname !== "/health") requests.push({ method: req.method, path: url.pathname, body, at: Date.now() });

  if (url.pathname === "/health") return send(res, 200, { ok: true });
  if (url.pathname === "/requests") return send(res, 200, requests);
  if (url.pathname === "/fx") return send(res, 200, { result: "success", rates: { GHS: 11.62 } });
  /* hosted checkout: hands back a checkout page on the stub (never the real gateway) */
  if (req.method === "POST" && url.pathname === "/initiate") {
    verdicts.set(String(body.transaction_id), { status: "pending", code: "111", reason: "Waiting for the customer" });
    return send(res, 200, { status: "success", code: "200", token: "stub-" + body.transaction_id, checkout_url: `http://127.0.0.1:${PORT}/pay/${body.transaction_id}` });
  }

  if (req.method === "POST" && url.pathname === "/v1.1/transaction/process") {
    const number = String(body.subscriber_number || "");
    if (number.endsWith("9999")) return;   /* never answers: the request times out on the balance service's side */
    const declined = number.endsWith("0000");
    const verdict = declined
      ? { status: "declined", code: "100", reason: "Insufficient funds in the mobile money wallet", transaction_id: body.transaction_id }
      : { status: "approved", code: "000", reason: "Transaction successful", transaction_id: body.transaction_id, amount: body.amount };
    verdicts.set(String(body.transaction_id), verdict);
    setTimeout(() => send(res, 200, verdict), 800);
    return;
  }
  const status = /^\/v1\.1\/users\/transactions\/([^/]+)\/status$/.exec(url.pathname);
  if (status) return send(res, 200, verdicts.get(decodeURIComponent(status[1])) || { status: "pending", code: "111", reason: "Pending" });
  send(res, 404, { error: "not_found" });
}).listen(PORT, () => console.log(`[e2e] payment gateway stub on http://127.0.0.1:${PORT}`));
