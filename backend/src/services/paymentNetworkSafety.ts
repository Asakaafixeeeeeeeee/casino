/** Tests and development must never dispatch money requests to a real provider, even with inherited credentials. */
export function assertSafePaymentNetwork(target: string): void {
  const hostname = new URL(target).hostname;
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  const isolated = process.env.NODE_ENV !== "production" || !!process.env.NODE_TEST_CONTEXT || process.env.PAYMENT_TEST_MODE === "true";
  const reservedMock = hostname.endsWith(".test") && !!process.env.NODE_TEST_CONTEXT;
  if (isolated && !loopback && !reservedMock) {
    console.error("[payment/security] External payment traffic blocked outside production (%s)", hostname);
    throw new Error("External payment traffic is disabled in tests and development; use a loopback mock gateway");
  }
}
