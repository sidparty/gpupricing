/**
 * TOML writer shared by the price-sync runners.
 *
 * Every synced provider writes its offerings through `offeringToml`, so the
 * generated files keep one key order and one quoting rule. Optional fields
 * are left out when undefined.
 */

/** Offering-level prices, written as the `[cost]` table. */
export interface OfferingCost {
  hourly?: number;
  spotHourly?: number;
}

/** One `[[availability]]` entry. Prices here override `[cost]`. */
export interface OfferingRegion {
  region: string;
  providerRegion?: string;
  hourly?: number;
  spotHourly?: number;
}

/** The content of one `providers/<id>/gpus/<offering>.toml` file. */
export interface OfferingFile {
  /** Comment lines for the top of the file, without the leading "# ". */
  comments: string[];
  baseGpu: string;
  instance: string;
  gpusPerInstance: number;
  vramGb?: number;
  vcpus?: number;
  memoryGb?: number;
  localStorageGb?: number;
  fabric?: string;
  lastUpdated: string;
  cost?: OfferingCost;
  availability: OfferingRegion[];
}

/** Quote a TOML basic string, escaping quotes, backslashes and control characters. */
export function tomlString(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === '"') escaped += `\\${char}`;
    else if (code < 0x20 || code === 0x7f)
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    else escaped += char;
  }
  return `"${escaped}"`;
}

export function offeringToml(file: OfferingFile): string {
  const lines = file.comments.map((comment) => `# ${comment}`);
  lines.push(`base_gpu = ${tomlString(file.baseGpu)}`);
  lines.push(`instance = ${tomlString(file.instance)}`);
  // Fractional GPU counts (partitioned GPUs) round to 6dp so 1/6 stays exact
  // enough for per-GPU price math without emitting a repeating decimal.
  const gpus = Number.isInteger(file.gpusPerInstance)
    ? String(file.gpusPerInstance)
    : String(Math.round(file.gpusPerInstance * 1e6) / 1e6);
  lines.push(`gpus_per_instance = ${gpus}`);
  if (file.vramGb !== undefined) lines.push(`vram_gb = ${file.vramGb}`);
  if (file.vcpus !== undefined) lines.push(`vcpus = ${file.vcpus}`);
  if (file.memoryGb !== undefined) lines.push(`memory_gb = ${file.memoryGb}`);
  if (file.localStorageGb !== undefined)
    lines.push(`local_storage_gb = ${file.localStorageGb}`);
  if (file.fabric !== undefined)
    lines.push(`fabric = ${tomlString(file.fabric)}`);
  lines.push(`last_updated = ${tomlString(file.lastUpdated)}`);
  if (file.cost !== undefined) {
    lines.push("");
    lines.push("[cost]");
    if (file.cost.hourly !== undefined)
      lines.push(`hourly = ${file.cost.hourly}`);
    if (file.cost.spotHourly !== undefined)
      lines.push(`spot_hourly = ${file.cost.spotHourly}`);
  }
  for (const entry of file.availability) {
    lines.push("");
    lines.push("[[availability]]");
    lines.push(`region = ${tomlString(entry.region)}`);
    if (entry.providerRegion !== undefined)
      lines.push(`provider_region = ${tomlString(entry.providerRegion)}`);
    if (entry.hourly !== undefined) lines.push(`hourly = ${entry.hourly}`);
    if (entry.spotHourly !== undefined)
      lines.push(`spot_hourly = ${entry.spotHourly}`);
  }
  return lines.join("\n") + "\n";
}
