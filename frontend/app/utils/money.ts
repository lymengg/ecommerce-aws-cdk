/** Formats an amount the way the API sends it (a plain number, from a `NUMERIC(12,2)` column). */
export function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}
