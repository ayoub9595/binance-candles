// One global pace gate for every outbound Binance REST page, shared by the
// on-demand history walk and the gap healer. Two independent pacers would each
// behave as if it owned the whole weight budget and together overrun it, so the
// slot clock lives here rather than inside either caller.
//
// Klines at limit=1000 cost 5 weight; one page per 300ms keeps worst-case usage
// near 1000 weight/min, under Binance's 1200/min budget even with the live
// ingestor running.

const PAGE_GAP_MS = 300;
let nextSlotAt = 0;

export function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + PAGE_GAP_MS;
  return at > now ? new Promise((resolve) => setTimeout(resolve, at - now)) : Promise.resolve();
}
