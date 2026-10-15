/** RX1: substitutions are shell words, never interpolated shell source. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export function wrapErrors(template: string): string[] {
  const names = [...template.matchAll(/\{([^\s{}]+)\}/g)].map(m => m[1]!);
  const errors = names.filter(n => !['cwd', 'timeout', 'cmd'].includes(n)).map(n => `exec.wrap: unknown placeholder {${n}}; use {cwd}, {timeout} and {cmd}`);
  if (!names.includes('cmd')) errors.push('exec.wrap: {cmd} is required; include the measurement command');
  return errors;
}
export function expandWrap(template: string, cwd: string, timeout: number, cmd: string): string {
  const values: Record<string, string> = { cwd, timeout: String(timeout), cmd };
  return template.replace(/\{([^\s{}]+)\}/g, (_, name: string) => shellQuote(values[name]!));
}
