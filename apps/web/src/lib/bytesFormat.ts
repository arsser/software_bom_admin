/** 人类可读二进制单位（1024） */
export function formatBytesHuman(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  const digits = v >= 100 || i < 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}
