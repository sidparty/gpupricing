#!/usr/bin/env bun
/**
 * Azure price sync runner.
 *
 *   bun packages/core/script/sync-azure.ts
 *
 * Fetches live Azure GPU pricing and (re)writes:
 *   - providers/azure/gpus/*.toml        (always regenerated)
 *   - providers/azure/provider.toml      (created if missing)
 *   - providers/azure/logo.svg           (created if missing)
 *   - regions/<slug>/region.toml         (created if missing)
 * Then run `bun validate` to check the result.
 */

import path from "path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";

import { syncAzure, type AzureOffering } from "../src/sync/azure.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const providerDir = path.join(root, "providers", "azure");
const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM

const AZURE_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M9.6 3.2 3 18.1h4.9l1.4-3.4 4.2 3.9-8 1.9h13.3z" />
  <path d="M11.4 6.4 6.9 18.4l6.9-1.6-2.6-2.5h-3z" opacity="0.6" />
</svg>
`;

function tomlString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function offeringToml(offering: AzureOffering): string {
  const lines: string[] = [];
  lines.push(
    `# AUTO-SYNCED from the Azure Retail Prices API (prices.azure.com) on ${stamp}.`,
  );
  lines.push(
    `# Instance->GPU mapping is curated in packages/core/src/sync/azure.ts; do not edit here.`,
  );
  lines.push(`base_gpu = ${tomlString(offering.baseGpu)}`);
  lines.push(`instance = ${tomlString(offering.instance)}`);
  lines.push(`gpus_per_instance = ${offering.gpusPerInstance}`);
  if (offering.vcpus !== undefined) lines.push(`vcpus = ${offering.vcpus}`);
  if (offering.memoryGb !== undefined)
    lines.push(`memory_gb = ${offering.memoryGb}`);
  if (offering.fabric !== undefined)
    lines.push(`fabric = ${tomlString(offering.fabric)}`);
  lines.push(`last_updated = ${tomlString(stamp)}`);
  for (const entry of offering.availability) {
    lines.push("");
    lines.push("[[availability]]");
    lines.push(`region = ${tomlString(entry.region)}`);
    lines.push(`provider_region = ${tomlString(entry.providerRegion)}`);
    lines.push(`hourly = ${entry.hourly}`);
    if (entry.spotHourly !== undefined)
      lines.push(`spot_hourly = ${entry.spotHourly}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  console.log("Fetching Azure GPU pricing…");
  const { offerings, regions } = await syncAzure();

  // Provider definition + logo (created once, then hand-owned).
  await fs.mkdir(path.join(providerDir, "gpus"), { recursive: true });
  const providerToml = path.join(providerDir, "provider.toml");
  if (!existsSync(providerToml)) {
    await Bun.write(
      providerToml,
      [
        `name = "Microsoft Azure"`,
        `doc = "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/"`,
        `type = "cloud"`,
        `api = "https://prices.azure.com/api/retail/prices"`,
        "",
      ].join("\n"),
    );
    console.log("  + providers/azure/provider.toml");
  }
  const logoPath = path.join(providerDir, "logo.svg");
  if (!existsSync(logoPath)) {
    await Bun.write(logoPath, AZURE_LOGO);
    console.log("  + providers/azure/logo.svg");
  }

  // Regenerate offering files. Remove any stale ones first.
  const gpusDir = path.join(providerDir, "gpus");
  for (const file of await fs.readdir(gpusDir)) {
    if (file.endsWith(".toml")) await fs.rm(path.join(gpusDir, file));
  }
  for (const offering of offerings) {
    await Bun.write(
      path.join(gpusDir, `${offering.id}.toml`),
      offeringToml(offering),
    );
    console.log(
      `  = providers/azure/gpus/${offering.id}.toml (${offering.availability.length} regions)`,
    );
  }

  // Ensure every referenced region exists (never overwrite curated ones).
  for (const [slug, region] of regions) {
    const regionToml = path.join(root, "regions", slug, "region.toml");
    if (!existsSync(regionToml)) {
      await fs.mkdir(path.dirname(regionToml), { recursive: true });
      await Bun.write(
        regionToml,
        [
          `name = ${tomlString(region.name)}`,
          `area = ${tomlString(region.area)}`,
          "",
        ].join("\n"),
      );
      console.log(`  + regions/${slug}/region.toml`);
    }
  }

  console.log(
    `\nDone: ${offerings.length} offerings across ${regions.size} regions. Run \`bun validate\`.`,
  );
}

await main();
