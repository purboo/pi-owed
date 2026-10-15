/**
 * SB5: the one formatter for times shown in human and agent text: local `HH:MM`, prefixed with the local date
 * (`YYYY-MM-DD HH:MM`) when it is not today. Ledger and JSON fields stay ISO UTC. An unparsable time is shown as is.
 */
export function clockTime(at: string | number | Date, now: number = Date.now()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  const two = (n: number): string => String(n).padStart(2, '0'), day = (x: Date): string => `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())}`;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return day(d) === day(new Date(now)) ? time : `${day(d)} ${time}`;
}
