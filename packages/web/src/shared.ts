export const DASH = "-";

export function escapeHtml(value: string | number) {
  return String(value).replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

export function formatNumber(value?: number) {
  return value === undefined ? DASH : value.toLocaleString();
}

/** Whole-dollar aware currency: "$49.24", "$1,234.00". */
export function formatUsd(value?: number) {
  if (value === undefined) return DASH;
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  });
}

/** Per-instance hourly price, e.g. "$49.24/hr" or "Contact sales". */
export function formatHourly(value?: number) {
  if (value === undefined) return "Contact sales";
  return `${formatUsd(value)}/hr`;
}

/** Derived per-GPU hourly price, e.g. "$6.16". */
export function formatPerGpu(value?: number) {
  if (value === undefined) return DASH;
  return formatUsd(value);
}

/** VRAM in gibibytes, e.g. "80 GB", "1,128 GB". */
export function formatVram(value?: number) {
  if (value === undefined) return DASH;
  return `${formatNumber(value)} GB`;
}

/** Dense compute throughput, e.g. "989" (unit lives in the column header). */
export function formatTflops(value?: number) {
  if (value === undefined) return DASH;
  return formatNumber(value);
}

export function formatWatts(value?: number) {
  return value === undefined ? DASH : `${formatNumber(value)} W`;
}

/** Storage given in GB, rendered as TB at/above 1000, e.g. "61.44 TB", "512 GB". */
export function formatStorage(gb?: number) {
  if (gb === undefined) return DASH;
  if (gb >= 1000) {
    const tb = gb / 1000;
    const rounded = Math.round(tb * 100) / 100;
    return `${rounded.toLocaleString()} TB`;
  }
  return `${formatNumber(gb)} GB`;
}

export function titleCase(value: string) {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function sortDate(value?: string) {
  return value ?? "";
}

export function sortNumber(value?: number) {
  return value === undefined ? "" : String(value);
}
