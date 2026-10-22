#!/usr/bin/env bun
/**
 * CoreWeave price sync runner.
 *
 *   bun packages/core/script/sync-coreweave.ts
 *
 * Scrapes https://www.coreweave.com/pricing and rewrites
 * providers/coreweave/gpus/*.toml. The sync owns that directory: it writes
 * one file per product in SKUS and deletes generated files whose product
 * left SKUS. It refuses to delete a file it did not generate (one without the
 * AUTO-SYNCED header). provider.toml, logo.svg and regions/ are never touched.
 *
 * Everything that can fail runs before the first write: the scrape and its
 * checks (see coreweave.ts), and a check of every new file the way
 * `bun validate` checks it (base_gpu inheritance, the offering schema, region
 * slugs). So a failed sync leaves the tree as it was.
 */

import path from "path";
import fs from "node:fs/promises";
import { ZodError } from "zod";

import {
  generateGpus,
  generateRegions,
  resolveOffering,
  type TomlTable,
  type TomlValue,
} from "../src/generate.js";
import {
  PRICING_URL,
  syncCoreWeave,
  type CoreWeaveOffering,
} from "../src/sync/coreweave.js";
import { offeringToml } from "../src/sync/toml.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const gpusDir = path.join(root, "providers", "coreweave", "gpus");
const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM
const HEADER = "# AUTO-SYNCED";

function coreweaveToml(offering: CoreWeaveOffering): string {
  return offeringToml({
    ...offering,
    comments: [
      `AUTO-SYNCED from ${PRICING_URL} on ${stamp}.`,
      "Product->GPU mapping and fabric are curated in packages/core/src/sync/coreweave.ts; do not edit here.",
      ...offering.notes,
    ],
    lastUpdated: stamp,
  });
}

function parseToml(text: string, file: string): TomlTable {
  try {
    // SAFETY: a TOML document always parses to a table at its root.
    return Bun.TOML.parse(text) as TomlTable;
  } catch (error) {
    // Bun throws a BuildMessage, which is not an Error and names no file.
    throw new Error(`${file} is not valid TOML: ${String(error)}`, {
      cause: error,
    });
  }
}

/** Every leaf of a parsed TOML value, as dot-path -> value text. */
function leaves(
  value: TomlValue,
  at: string,
  into: Map<string, string>,
): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => leaves(item, `${at}[${index}]`, into));
  } else if (value instanceof Date || !(value instanceof Object)) {
    into.set(at, String(value));
  } else {
    for (const [key, item] of Object.entries(value)) {
      leaves(item, at === "" ? key : `${at}.${key}`, into);
    }
  }
  return into;
}

/** "path: old -> new" for each value that differs, apart from the sync date. */
function describeChanges(id: string, before: string, after: string): string[] {
  let old: Map<string, string>;
  try {
    old = leaves(parseToml(before, `${id}.toml`), "", new Map());
  } catch {
    return ["the old file is not valid TOML; it is replaced"];
  }
  const now = leaves(parseToml(after, `${id}.toml`), "", new Map());
  const paths = new Set([...old.keys(), ...now.keys()]);
  paths.delete("last_updated");
  return [...paths]
    .filter((key) => old.get(key) !== now.get(key))
    .map(
      (key) => `${key}: ${old.get(key) ?? "(none)"} -> ${now.get(key) ?? "(none)"}`,
    );
}

interface SyncPlan {
  /** offering id -> new file text, for files that are new or differ. */
  writes: Map<string, string>;
  removals: string[];
  /** One line per changed file, printed after the writes. */
  report: string[];
  total: number;
  unchanged: number;
}

/** Fetch, check and diff everything. Throws before the tree is touched. */
async function plan(): Promise<SyncPlan> {
  const gpus = await generateGpus(path.join(root, "gpus"));
  const regions = await generateRegions(path.join(root, "regions"));

  console.log(`Fetching ${PRICING_URL}…`);
  const { offerings, warnings } = await syncCoreWeave(gpus);
  for (const warning of warnings) console.warn(`  ! ${warning}`);

  const files = new Map<string, string>();
  for (const offering of offerings) {
    const text = coreweaveToml(offering);
    const offeringPath = path.join(gpusDir, `${offering.id}.toml`);
    resolveOffering(
      parseToml(text, offeringPath),
      offering.id,
      offeringPath,
      gpus,
      regions,
    );
    files.set(offering.id, text);
  }

  await fs.mkdir(gpusDir, { recursive: true });
  const existing = new Map<string, string>();
  for (const file of await fs.readdir(gpusDir)) {
    if (!file.endsWith(".toml")) continue;
    const text = await Bun.file(path.join(gpusDir, file)).text();
    existing.set(file.slice(0, -".toml".length), text);
  }

  const result: SyncPlan = {
    writes: new Map(),
    removals: [],
    report: [],
    total: files.size,
    unchanged: 0,
  };
  for (const [id, text] of existing) {
    if (files.has(id)) continue;
    if (!text.startsWith(HEADER)) {
      throw new Error(
        `providers/coreweave/gpus/${id}.toml is not a synced file, and the sync would delete it. Add its product to SKUS in coreweave.ts, or move the file.`,
      );
    }
    result.removals.push(id);
    result.report.push(`  - ${id} (its product left SKUS)`);
  }
  for (const [id, text] of files) {
    const before = existing.get(id);
    if (before === text) {
      result.unchanged++;
      continue;
    }
    result.writes.set(id, text);
    if (before === undefined) {
      result.report.push(`  + ${id}`);
      continue;
    }
    const changes = describeChanges(id, before, text);
    result.report.push(
      changes.length === 0
        ? `  ~ ${id} (date and comments only)`
        : `  ~ ${id}\n${changes.map((change) => `      ${change}`).join("\n")}`,
    );
  }
  return result;
}

let sync: SyncPlan;
try {
  sync = await plan();
} catch (error) {
  if (error instanceof ZodError) {
    console.error("Validation error:", error.errors);
    console.error("When parsing:", error.cause);
  } else if (error instanceof Error) {
    console.error(`CoreWeave sync failed: ${error.message}`);
  } else {
    console.error("CoreWeave sync failed:", error);
  }
  console.error("Nothing was written.");
  process.exit(1);
}

for (const id of sync.removals) {
  await fs.rm(path.join(gpusDir, `${id}.toml`));
}
for (const [id, text] of sync.writes) {
  await Bun.write(path.join(gpusDir, `${id}.toml`), text);
}
for (const line of sync.report) console.log(line);
console.log(
  `\nDone: ${sync.total} CoreWeave offerings. ${sync.writes.size} written, ${sync.removals.length} removed, ${sync.unchanged} unchanged.`,
);
