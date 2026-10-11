const prefixes = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

export function parse_value(text) {
  const match = String(text).trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([pnuµmkKMG]?)/i);
  if (!match) return NaN;
  let prefix = match[2];
  if (prefix === 'M' || prefix === 'K' || prefix === 'G') return Number(match[1]) * prefixes[prefix];
  prefix = prefix.toLowerCase();
  if (prefix === 'g') prefix = 'G';
  return Number(match[1]) * (prefix ? prefixes[prefix] : 1);
}

const steps = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

export function format_value(value, unit = '', digits = 3) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1e-15) return `0 ${unit}`.trim();
  const size = Math.abs(value);
  for (const [scale, prefix] of steps) {
    if (size >= scale * 0.9995) {
      const scaled = value / scale;
      return `${Number(scaled.toPrecision(digits))} ${prefix}${unit}`.trim();
    }
  }
  return `${Number((value / 1e-12).toPrecision(digits))} p${unit}`;
}
