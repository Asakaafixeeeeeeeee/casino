import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutBaseFor,
  credentialHints,
  depositReference,
  loadTellerConfig,
  newTxId,
  paidPesewas,
  reasonText,
  tellerAmountMajor,
  verdict,
} from "../src/services/teller.js";

test("Teller amount conversion uses provider minor units", () => {
  assert.equal(tellerAmountMajor(10), "000000001000");
  assert.equal(tellerAmountMajor(0.01), "000000000001");
  assert.equal(tellerAmountMajor(25.5), "000000002550");
});

test("Teller amount conversion rejects invalid values", () => {
  assert.throws(() => tellerAmountMajor(0), /positive/);
  assert.throws(() => tellerAmountMajor(Number.NaN), /positive/);
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
  for (let i = 0; i < 50; i++) assert.match(newTxId(), /^\d{12}$/);
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
