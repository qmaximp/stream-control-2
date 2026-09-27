// Оценка отставания локальных часов от серверных — чтобы таймер шёл синхронно на всех устройствах.
// Оценка берётся из broadcast'ов element:updated по запущенным таймерам:
// sample = локально_сейчас - startTime(сервер) - elapsed(на момент отправки) ≈ сдвиг часов + латентность.
export const serverClockLag = { ms: 0 };

export function noteServerClock(el: { isRunning?: boolean; startTime?: number | null; elapsed?: number | null }) {
  if (!el.isRunning || !el.startTime) return;
  const sample = Date.now() - el.startTime - (el.elapsed || 0);
  if (sample < 0 || sample > 10000) return;
  serverClockLag.ms = serverClockLag.ms ? Math.round(serverClockLag.ms * 0.6 + sample * 0.4) : sample;
}
