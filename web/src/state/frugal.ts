/** A connection that costs, or a user who asked to save data: no speculative requests (the profiles' prefetch, app/warm.ts's idle loads). */
export function frugal(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return connection?.saveData === true || connection?.effectiveType === "2g" || connection?.effectiveType === "slow-2g";
}
