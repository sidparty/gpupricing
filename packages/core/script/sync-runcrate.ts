#!/usr/bin/env bun
/**
 * Runcrate price sync runner.
 *
 *   bun packages/core/script/sync-runcrate.ts
 *
 * Fetches the live Runcrate pricing feed and (re)writes:
 *   - providers/runcrate/gpus/*.toml     (always regenerated)
 *   - providers/runcrate/provider.toml   (created if missing)
 *   - providers/runcrate/logo.svg        (created if missing)
 *   - regions/<slug>/region.toml         (created if missing)
 * Then run `bun validate` to check the result.
 */

import path from "path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";

import {
  FEED_URL,
  syncRuncrate,
  type RuncrateOffering,
} from "../src/sync/runcrate.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const providerDir = path.join(root, "providers", "runcrate");
const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM

// Terminal prompt in a rounded square, drawn with currentColor.
const RUNCRATE_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
  <path d="M7.5 9 11 12l-3.5 3" />
  <path d="M13 15.5h3.5" />
</svg>
`;

function tomlString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function offeringToml(offering: RuncrateOffering): string {
  const lines: string[] = [];
  lines.push(`# AUTO-SYNCED from ${FEED_URL} on ${stamp}.`);
  lines.push(
    `# GPU and location mapping is curated in packages/core/src/sync/runcrate.ts; do not edit here.`,
  );
  lines.push(
    `# The feed publishes one starting on-demand price per GPU type, not one per location,`,
  );
  lines.push(`# so every location listed below carries that same price.`);
  lines.push(`base_gpu = ${tomlString(offering.baseGpu)}`);
  lines.push(`instance = ${tomlString(offering.instance)}`);
  lines.push(`gpus_per_instance = ${offering.gpusPerInstance}`);
  lines.push(`last_updated = ${tomlString(stamp)}`);
  lines.push("");
  lines.push("[cost]");
  lines.push(`hourly = ${offering.hourly}`);
  for (const entry of offering.availability) {
    lines.push("");
    lines.push("[[availability]]");
    lines.push(`region = ${tomlString(entry.region)}`);
    lines.push(`provider_region = ${tomlString(entry.providerRegion)}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  console.log("Fetching Runcrate GPU pricing...");
  const { offerings, regions, unmapped, skipped } = await syncRuncrate();

  // Provider definition + logo (created once, then hand-owned).
  await fs.mkdir(path.join(providerDir, "gpus"), { recursive: true });
  const providerToml = path.join(providerDir, "provider.toml");
  if (!existsSync(providerToml)) {
    await Bun.write(
      providerToml,
      [
        `name = "Runcrate"`,
        `doc = "https://www.runcrate.ai/pricing"`,
        `type = "cloud"`,
        `api = ${tomlString(FEED_URL)}`,
        "",
      ].join("\n"),
    );
    console.log("  + providers/runcrate/provider.toml");
  }
  const logoPath = path.join(providerDir, "logo.svg");
  if (!existsSync(logoPath)) {
    await Bun.write(logoPath, RUNCRATE_LOGO);
    console.log("  + providers/runcrate/logo.svg");
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
      `  = providers/runcrate/gpus/${offering.id}.toml (${offering.availability.length} regions)`,
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

  for (const reason of skipped) console.warn(`  ! skipped ${reason}`);
  if (unmapped.length > 0) {
    console.warn(`  ! unmapped locations (skipped): ${unmapped.join(", ")}`);
  }
  console.log(
    `\nDone: ${offerings.length} offerings across ${regions.size} regions. Run \`bun validate\`.`,
  );
}

await main();
