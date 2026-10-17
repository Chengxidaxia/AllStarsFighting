/** 清洗外部输入的显示名：去控制字符、去首尾空白、限长，空则回退。 */
export function sanitizeName(raw: unknown, fallback: string, maxLen: number): string {
  if (typeof raw !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}
