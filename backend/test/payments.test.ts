import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  checkoutBaseFor,
  checkoutEmail,
  canonicalTellerSubscriberNumber,
  credentialHints,
  depositReference,
  initiatePayout,
  loadTellerConfig,
  newTxId,
  networkForPhone,
  paidPesewas,
  reasonText,
  requestMomoPayment,
  tellerAmountMajor,
  TellerRequestError,
  type MomoNetwork,
  verdict,
} from "../src/services/teller.js";

async function mockGateway(status: number, body: Record<string, unknown>) {
  const requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadTellerConfig({
    TELLER_BASE_URL: base,
    TELLER_CHECKOUT_URL: base,
    TELLER_MERCHANT_ID: "TTM-00000001",
    TELLER_API_USERNAME: "user",
    TELLER_API_KEY: "key",
  } as NodeJS.ProcessEnv);
  return { config, requests, close: () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())) };
}

test("Teller amount conversion uses provider minor units", () => {
  assert.equal(tellerAmountMajor(10), "000000001000");
  assert.equal(tellerAmountMajor(0.01), "000000000001");
  assert.equal(tellerAmountMajor(2), "000000000200");
  assert.equal(tellerAmountMajor(25.5), "000000002550");
});

test("Mobile-money payload sends exact network identifiers and 12-digit pesewas", async () => {
  const gateway = await mockGateway(200, { code: "000", status: "approved" });
  const networks: MomoNetwork[] = ["MTN", "VDF", "ATL", "TGO"];
  try {
    for (const [i, network] of networks.entries()) {
      await requestMomoPayment(gateway.config, {
        transactionId: String(i + 1).padStart(12, "0"),
        amountMajor: 2,
        subscriberNumber: "233241234195",
        network,
        desc: "DES" + String(i + 1).padStart(12, "0"),
      });
    }
    assert.deepEqual(gateway.requests.map((request) => request.url), Array(4).fill("/v1.1/transaction/process"));
    assert.deepEqual(gateway.requests.map((request) => request.body["r-switch"]), networks);
    assert.deepEqual(gateway.requests.map((request) => request.body.amount), Array(4).fill("000000000200"));
    assert.deepEqual(gateway.requests.map((request) => request.body.transaction_id), networks.map((_, i) => String(i + 1).padStart(12, "0")));
  } finally {
    await gateway.close();
  }
});

test("A non-2xx response cannot approve a mobile-money payment", async () => {
  const gateway = await mockGateway(503, { code: "000", status: "approved" });
  try {
    await assert.rejects(
      requestMomoPayment(gateway.config, {
        transactionId: "000000000001",
        amountMajor: 2,
        subscriberNumber: "233241234195",
        network: "MTN",
        desc: "DES000000000001",
      }),
      (error: unknown) => error instanceof TellerRequestError && !error.declined,
    );
  } finally {
    await gateway.close();
  }
});

test("A non-2xx response cannot approve a payout", async () => {
  const gateway = await mockGateway(503, { code: "000", status: "approved" });
  try {
    await assert.rejects(
      initiatePayout(gateway.config, {
        transactionId: "000000000001",
        amountMajor: 2,
        phone: "0241234195",
        network: "MTN",
        desc: "withdrawal",
      }),
      (error: unknown) => error instanceof TellerRequestError && !error.declined,
    );
  } finally {
    await gateway.close();
  }
});

test("Teller amount conversion rejects invalid values", () => {
  assert.throws(() => tellerAmountMajor(0), /positive/);
  assert.throws(() => tellerAmountMajor(Number.NaN), /positive/);
  assert.throws(() => tellerAmountMajor(10.005), /two decimal places/);
  assert.throws(() => tellerAmountMajor(10_000_000_000), /supported range/);
});

test("Ghanaian mobile-money numbers are normalized strictly and mapped to supported networks", () => {
  assert.equal(canonicalTellerSubscriberNumber("0241234195"), "233241234195");
  assert.equal(canonicalTellerSubscriberNumber("+233 24 123 4195"), "233241234195");
  assert.equal(canonicalTellerSubscriberNumber("00233241234195"), "233241234195");
  assert.equal(canonicalTellerSubscriberNumber("abc233241234195"), null);
  assert.equal(canonicalTellerSubscriberNumber("233291234567"), null);
  assert.equal(canonicalTellerSubscriberNumber(true), null);
  assert.equal(networkForPhone("0591234567"), "MTN");
  assert.equal(networkForPhone("0501234567"), "VDF");
  assert.equal(networkForPhone("0571234567"), "ATL");
  assert.equal(networkForPhone("024123"), null);
  assert.equal(networkForPhone("abc0241234567"), null);
});

test("Teller config reports only missing variable names", () => {
  assert.throws(
    () => loadTellerConfig({ TELLER_MERCHANT_ID: "merchant" }),
    /missing environment variables: TELLER_API_USERNAME, TELLER_API_KEY/,
  );
  assert.doesNotThrow(() => loadTellerConfig({
    TELLER_MERCHANT_ID: "merchant",
    TELLER_API_USERNAME: "username",
    TELLER_API_KEY: "secret",
  }));
});

test("Hosted checkout uses its own host, matching the API mode", () => {
  assert.equal(checkoutBaseFor("https://prod.theteller.net"), "https://checkout.theteller.net");
  assert.equal(checkoutBaseFor("https://test.theteller.net"), "https://checkout-test.theteller.net");
  const config = loadTellerConfig({
    TELLER_BASE_URL: "https://prod.theteller.net/",
    TELLER_MERCHANT_ID: "TTM-1",
    TELLER_API_USERNAME: "user",
    TELLER_API_KEY: "secret",
  });
  assert.equal(config.apiBaseUrl, "https://prod.theteller.net");
  assert.equal(config.checkoutBaseUrl, "https://checkout.theteller.net");
});

test("The API key is used exactly as issued, never decoded", () => {
  const key = "NWZlN2NmNjhjYTI2ZGQ4NzlhZTU1YTQ5MDQ5Mjc0MDE=";
  const config = loadTellerConfig({ TELLER_MERCHANT_ID: "TTM-00012020", TELLER_API_USERNAME: "u", TELLER_API_KEY: key });
  assert.equal(config.apiKey, key);
});

test("The integration guide's setting names work too", () => {
  const base = { TELLER_MERCHANT_ID: "TTM-00012020", TELLER_API_USER: "guide-user", TELLER_API_KEY: "k" };
  const live = loadTellerConfig({ ...base, TELLER_MODE: "live" });
  assert.equal(live.apiUsername, "guide-user");
  assert.equal(live.apiBaseUrl, "https://prod.theteller.net");
  assert.equal(live.checkoutBaseUrl, "https://checkout.theteller.net");
  const sandbox = loadTellerConfig({ ...base, TELLER_MODE: "test" });
  assert.equal(sandbox.apiBaseUrl, "https://test.theteller.net");
  assert.equal(sandbox.checkoutBaseUrl, "https://checkout-test.theteller.net");
});

test("Transaction ids are 12 digits", () => {
  for (let i = 0; i < 500; i++) assert.match(newTxId(), /^1111\d{8}$/);
});

test("A deposit's reference is DES + its 12-digit TheTeller number", () => {
  assert.equal(depositReference("004512345678"), "DES004512345678");
  for (let i = 0; i < 20; i++) assert.match(depositReference(newTxId()), /^DES\d{12}$/);
});

test("verdict: only a clear answer is final", () => {
  assert.equal(verdict({ code: "000" }), "approved");
  assert.equal(verdict({ status: "Approved" }), "approved");
  assert.equal(verdict({ status: "successful" }), "approved");
  assert.equal(verdict({ status: "declined" }), "declined");
  assert.equal(verdict({ status: "failed" }), "declined");
  assert.equal(verdict({ status: "pending" }), null);
  assert.equal(verdict({ code: 600, status: "route error" }), null);
  assert.equal(verdict(null), null);
});

test("paidPesewas reads a 12-digit pesewa string or a cedi amount", () => {
  assert.equal(paidPesewas("000000002550"), 2550);
  assert.equal(paidPesewas(25.5), 2550);
  assert.equal(paidPesewas("10.00"), 1000);
  assert.equal(paidPesewas(undefined), null);
  assert.equal(paidPesewas(""), null);
  assert.equal(paidPesewas("abc"), null);
});

test("reasonText flattens TheTeller's per-field reasons", () => {
  assert.equal(reasonText("Access Denied"), "Access Denied");
  assert.equal(reasonText({ amount: ["is required"], email: ["is invalid"] }), "is required; is invalid");
  assert.equal(reasonText(undefined), "");
});

test("Chat markup around pasted credentials is stripped and reported", () => {
  const env = { TELLER_MERCHANT_ID: "*TTM-00012020*", TELLER_API_USERNAME: " `user` ", TELLER_API_KEY: "a2V5PQ==" };
  const config = loadTellerConfig(env);
  assert.equal(config.merchantId, "TTM-00012020");
  assert.equal(config.apiUsername, "user");
  assert.equal(config.apiKey, "a2V5PQ==");
  assert.deepEqual(credentialHints(env), { merchantIdLooksValid: true, credentialsHadStrayChars: true });
  assert.deepEqual(
    credentialHints({ TELLER_MERCHANT_ID: "TTM-00012020", TELLER_API_USERNAME: "user", TELLER_API_KEY: "k\n" }),
    { merchantIdLooksValid: true, credentialsHadStrayChars: false },
  );
  assert.equal(credentialHints({ TELLER_MERCHANT_ID: "TTM-12020" }).merchantIdLooksValid, false);
});

test("The checkout email is always a valid address", () => {
  assert.equal(checkoutEmail("42", "asakaa-casino.onrender.com"), "42@asakaa-casino.onrender.com");
  assert.equal(checkoutEmail("a b:c/d", "asakaa-casino.onrender.com"), "abcd@asakaa-casino.onrender.com");
  assert.equal(checkoutEmail("::", "localhost"), "player@example.com");
});
