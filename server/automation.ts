import { getKv } from "./kv";

// Server-side automation switches: apply to every device and are enforced by
// the API (not just hidden buttons), so nothing runs or bills unless allowed.
export type AutomationSettings = {
  /** 0 = off (only manual "Pindai sekarang"), otherwise minutes a result stays fresh. */
  autoScanMinutes: 0 | 15 | 30 | 60;
  /** Claude reviews new candidates without being asked. */
  autoReview: boolean;
};

export const DEFAULT_AUTOMATION: AutomationSettings = { autoScanMinutes: 15, autoReview: true };
const KEY = "solscreen:settings:automation";

export async function getAutomation(): Promise<AutomationSettings> {
  const saved = await getKv().get<Partial<AutomationSettings>>(KEY).catch(() => null);
  const minutes = saved?.autoScanMinutes;
  return {
    autoScanMinutes: minutes === 0 || minutes === 15 || minutes === 30 || minutes === 60 ? minutes : DEFAULT_AUTOMATION.autoScanMinutes,
    autoReview: typeof saved?.autoReview === "boolean" ? saved.autoReview : DEFAULT_AUTOMATION.autoReview,
  };
}

export async function setAutomation(next: AutomationSettings): Promise<AutomationSettings> {
  await getKv().set(KEY, next);
  return next;
}
