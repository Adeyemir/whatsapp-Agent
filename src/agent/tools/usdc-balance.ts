/** Arc reports native gas and ERC-20 USDC as two views of one balance. */
export function usdcTokenAmount(balances: unknown): string | null {
  if (!Array.isArray(balances)) return null;
  const token = balances.find((entry) =>
    entry?.token?.symbol === "USDC" &&
    entry.token.isNative === false &&
    entry.token.decimals === 6 &&
    typeof entry.amount === "string" &&
    /^\d+(?:\.\d{1,6})?$/.test(entry.amount));
  return token?.amount ?? null;
}
