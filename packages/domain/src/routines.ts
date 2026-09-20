export type Routine = { id: string; botId: string; threadId: string; title: string; prompt: string; intervalMinutes: number; enabled: boolean; nextRunAt: string; createdAt: string; updatedAt: string };
export function advanceDue(previous: number, intervalMinutes: number, now = Date.now()): number {
  const step = intervalMinutes * 60_000; let next = previous + step;
  while (next <= now) next += step;
  return next;
}
