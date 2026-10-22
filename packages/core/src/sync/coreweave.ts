/**
 * CoreWeave GPU price sync.
 *
 * CoreWeave has no pricing API, so this reads the public pricing page
 * (https://www.coreweave.com/pricing). The page is static HTML. Under the
 * "On-demand GPU instances" heading it has one table per region, and each
 * row carries a stable `data-product` slug plus the GPU count, VRAM, vCPUs,
 * RAM, local storage, on-demand price and spot price. So unlike Azure, the
 * instance specs come from the page itself. The curated SKUS table only says
 * which canonical GPU each product is, and adds the cluster fabric, which the
 * page does not list.
 *
 * The parser reads columns by header text, not by position. A layout or value
 * it does not recognize stops the sync before a file is written, and so does
 * a product in SKUS or a region in REGIONS that the page no longer shows:
 * a removal is a deliberate edit to those tables, never a side effect of a
 * misread page. Only additions that the tables cannot map yet (an unknown
 * product, region label or column) are skipped with a warning.
 *
 * HTMLRewriter is built into both Bun and Cloudflare Workers, so the parser
 * also runs in a Worker.
 */

import { z } from "zod";

import type { GpuMetadata } from "../schema.js";
import type { OfferingCost, OfferingRegion } from "./toml.js";

export const PRICING_URL = "https://www.coreweave.com/pricing";

/** The scraper names itself; a sync makes one request. */
const USER_AGENT = "gpupricing-sync (+https://github.com/sidparty/gpupricing)";

export interface CoreWeaveSku {
  /** The row's `data-product` slug on the pricing page. */
  product: string;
  /** Offering file id under providers/coreweave/gpus/. */
  id: string;
  /** Canonical GPU id under gpus/. */
  baseGpu: string;
  /**
   * VRAM per GPU when CoreWeave ships a variant that differs from the
   * canonical GPU. The page must list the same value.
   */
  vramGb?: number;
  /** Cluster network fabric. The pricing page does not list it. */
  fabric: string;
  /** Extra comment lines for the top of the offering file. */
  notes?: string[];
}

export interface CoreWeaveOffering {
  id: string;
  instance: string;
  baseGpu: string;
  gpusPerInstance: number;
  vramGb?: number;
  vcpus: number;
  memoryGb: number;
  localStorageGb: number;
  fabric: string;
  notes: string[];
  cost?: OfferingCost;
  availability: OfferingRegion[];
}

export interface CoreWeaveSyncResult {
  offerings: CoreWeaveOffering[];
  /** Additions the sync skipped: unknown products, region labels, columns. */
  warnings: string[];
}

// Footnote 1 on the pricing page.
const NVL72_SLICE =
  "One instance is a 4-GPU slice of the 72-GPU NVL72 rack: 2 Superchips, each with 1 Grace CPU and 2 Blackwell GPUs.";

/**
 * Curated product -> GPU mapping. Specs and prices come from the page; this
 * table adds what the page cannot say: which canonical GPU a product is, and
 * its cluster fabric (from the "GPU connectivity" row of each instance page on
 * docs.coreweave.com). A product on the page but not here is skipped with a
 * warning. A product here but not on the page stops the sync: remove it here
 * if CoreWeave stopped selling it, or fix its slug if CoreWeave renamed it.
 */
export const SKUS: CoreWeaveSku[] = [
  {
    product: "nvidia-gb300-nvl72",
    id: "gb300-nvl72",
    baseGpu: "nvidia/gb300-nvl72",
    fabric: "Rack-scale NVLink 5 + Quantum-X800 InfiniBand",
    notes: [NVL72_SLICE],
  },
  {
    product: "nvidia-gb200-nvl72",
    id: "gb200-nvl72",
    baseGpu: "nvidia/gb200-nvl72",
    fabric: "Rack-scale NVLink 5 + Quantum-2 InfiniBand",
    notes: [NVL72_SLICE],
  },
  {
    product: "nvidia-b300",
    id: "b300",
    baseGpu: "nvidia/b300",
    fabric: "NVLink 5 + Quantum-X800 InfiniBand",
  },
  {
    product: "nvidia-b200",
    id: "b200",
    baseGpu: "nvidia/b200",
    fabric: "NVLink 5 + Quantum-2 InfiniBand",
  },
  {
    product: "nvidia-rtx-pro-6000-blackwell-server-edition",
    id: "rtx-pro-6000-blackwell",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    fabric: "Ethernet (PCIe)",
  },
  {
    product: "nvidia-rtx-pro-6000-blackwell-server-edition-standard-memory",
    id: "rtx-pro-6000-blackwell-standard-memory",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    fabric: "Ethernet (PCIe)",
  },
  {
    product: "nvidia-gh200",
    id: "gh200",
    baseGpu: "nvidia/gh200",
    fabric: "NVLink-C2C + Ethernet",
  },
  {
    product: "hgx-h100",
    id: "h100-sxm",
    baseGpu: "nvidia/h100-sxm",
    fabric: "NVLink + Quantum-2 InfiniBand",
  },
  {
    product: "hgx-h200",
    id: "h200-sxm",
    baseGpu: "nvidia/h200-sxm",
    fabric: "NVLink + Quantum-2 InfiniBand",
  },
  {
    product: "nvidia-l40",
    id: "l40",
    baseGpu: "nvidia/l40",
    fabric: "Ethernet (PCIe)",
  },
  {
    product: "nvidia-l40s",
    id: "l40s",
    baseGpu: "nvidia/l40s",
    fabric: "Ethernet (PCIe)",
  },
  {
    product: "nvidia-a100",
    id: "a100-sxm",
    baseGpu: "nvidia/a100-sxm",
    fabric: "NVLink + Ethernet",
  },
];

/**
 * The region label above each table ("REGION: NORTH AMERICA"), lower-cased,
 * -> region slug. CoreWeave prices by continent, so the slugs are the
 * continental ones. Availability entries follow this order. A table with an
 * unmapped label is skipped with a warning; a slug here with no table stops
 * the sync.
 */
const REGIONS = new Map([
  ["north america", "north-america"],
  ["europe", "europe"],
]);

/** One region's GPU table as it appears on the page, as cleaned cell text. */
export interface PricingTable {
  /** The label above the table, e.g. "REGION: NORTH AMERICA". */
  label: string;
  headers: string[];
  rows: PricingTableRow[];
}

export interface PricingTableRow {
  /** The row's `data-product` slug. */
  product: string;
  /** The desktop-layout cells, one per header. */
  cells: string[];
}

/** A table while the parser reads it. */
interface ParsedTable extends PricingTable {
  rows: ParsedRow[];
  /** Webflow paginates long lists, which would hide rows on other pages. */
  paginated: boolean;
}

interface ParsedRow extends PricingTableRow {
  /** Webflow conditional visibility keeps hidden items in the HTML. */
  hidden: boolean;
}

/** A footnote marker after a value: "4^1", "Price²". */
const FOOTNOTE = /\s*(?:\^\d+|[¹²³⁰-⁹]+)$/;
/** "8", "2,048", "61.44". */
const NUMBER = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** Price cells that mean "no listed price". */
const NO_PRICE = new Set(["contact sales", "n/a"]);
/** HTMLRewriter hands over raw text, so decode the entities a table can hold. */
const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["reg", "®"],
  ["trade", "™"],
  ["sup1", "¹"],
  ["sup2", "²"],
  ["sup3", "³"],
]);

/** A product name without footnote markers or trademark signs. */
const Name = z
  .string()
  .transform((cell) =>
    cell.replace(FOOTNOTE, "").replace(/[®™]/g, "").replace(/\s+/g, " ").trim(),
  )
  .pipe(z.string().min(1, "the GPU model name is empty"));

/** A count or size cell. */
const Quantity = z.string().transform((cell, context) => {
  const value = cell.replace(FOOTNOTE, "");
  if (!NUMBER.test(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `expected a number, found "${cell}"`,
    });
    return z.NEVER;
  }
  return Number(value.replaceAll(",", ""));
});

/** A price cell: "$49.24", or undefined for "Contact sales" and "N/A". */
const Price = z.string().transform((cell, context) => {
  const value = cell.replace(FOOTNOTE, "");
  if (NO_PRICE.has(value.toLowerCase())) return undefined;
  const amount = value.startsWith("$") ? value.slice(1) : "";
  if (!NUMBER.test(amount)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `expected a price such as "$1.23", "Contact sales" or "N/A", found "${cell}"`,
    });
    return z.NEVER;
  }
  return Number(amount.replaceAll(",", ""));
});

/** One table row, keyed by column, in the page's own units. */
const PricingRow = z.object({
  name: Name,
  gpuCount: Quantity.pipe(z.number().int().positive()),
  vramGb: Quantity,
  vcpus: Quantity,
  memoryGb: Quantity,
  localStorageTb: Quantity,
  onDemand: Price,
  spot: Price,
  inferencePerGpu: Price.optional(),
});

type PricingRow = z.infer<typeof PricingRow>;
type Column = keyof z.input<typeof PricingRow>;

interface PageColumn {
  /** The header text on the page. Matching ignores case, spacing and footnotes. */
  header: string;
  column: Column;
  required: boolean;
}

const COLUMNS: PageColumn[] = [
  { header: "GPU Model", column: "name", required: true },
  { header: "GPU Count", column: "gpuCount", required: true },
  { header: "VRAM (GB)", column: "vramGb", required: true },
  { header: "vCPUs", column: "vcpus", required: true },
  { header: "System RAM (GB)", column: "memoryGb", required: true },
  { header: "Local Storage (TB)", column: "localStorageTb", required: true },
  { header: "On-Demand Price (Per Hour)", column: "onDemand", required: true },
  { header: "Spot Price (Per Hour)", column: "spot", required: true },
  // North America only. Footnote 2: "Pricing based on GPUs is exclusively
  // applicable to the CoreWeave inference platform customers." Not stored;
  // it only cross-checks the GPU count.
  {
    header: "Inference Single GPU Price (Per Hour)",
    column: "inferencePerGpu",
    required: false,
  },
];

const COLUMN_BY_KEY = new Map(
  COLUMNS.map((entry) => [normalize(entry.header), entry.column]),
);

/** The specs one offering holds; every region must agree on them. */
const SPEC_FIELDS = [
  "gpuCount",
  "vramGb",
  "vcpus",
  "memoryGb",
  "localStorageTb",
] as const;

const GPU_SECTION = normalize("On-demand GPU instances");

/** The desktop cells of a table row; the row also holds mobile-layout copies. */
const ROW_CELL = "div.table-row-v2 div.table-grid > div.table-v2-cell";
const HEADER_CELL = "div.table-v2-header .table-header-text";

/**
 * Pull the GPU pricing tables out of the page. Only tables under the
 * "On-demand GPU instances" heading count: the CPU tables below it reuse the
 * same markup, and the Kubernetes product modals repeat the product slugs.
 * Rows that Webflow hides with conditional visibility are left out.
 */
export async function parsePricingPage(html: string): Promise<PricingTable[]> {
  const tables: ParsedTable[] = [];
  let section = "";
  let heading = "";
  let eyebrow = "";
  let label = "";
  let table: ParsedTable | undefined;
  let row: ParsedRow | undefined;

  await new HTMLRewriter()
    .on("h2", {
      element(element) {
        heading = "";
        element.onEndTag(() => {
          section = normalize(heading);
          label = "";
        });
      },
      text(chunk) {
        heading += chunk.text;
      },
    })
    .on("strong.eyebrow", {
      element(element) {
        eyebrow = "";
        element.onEndTag(() => {
          label = eyebrow;
        });
      },
      text(chunk) {
        eyebrow += chunk.text;
      },
    })
    .on("strong.eyebrow *", {
      element(element) {
        eyebrow += boundary(element);
      },
    })
    .on("div.table-v2", {
      element(element) {
        if (section !== GPU_SECTION) return;
        const found: ParsedTable = {
          label,
          headers: [],
          rows: [],
          paginated: false,
        };
        tables.push(found);
        table = found;
        // Each table needs its own label; a missing one must not inherit
        // the label of the table before it.
        label = "";
        element.onEndTag(() => {
          table = undefined;
        });
      },
    })
    .on("div.table-v2 .w-pagination-wrapper", {
      element() {
        if (table) table.paginated = true;
      },
    })
    .on(HEADER_CELL, {
      element() {
        table?.headers.push("");
      },
      text(chunk) {
        if (table) appendText(table.headers, chunk.text);
      },
    })
    .on(`${HEADER_CELL} *`, {
      element(element) {
        if (table) appendText(table.headers, boundary(element));
      },
    })
    .on("div.table-row-v2", {
      element(element) {
        if (table === undefined) return;
        const found: ParsedRow = {
          product: "",
          cells: [],
          hidden: isHidden(element),
        };
        table.rows.push(found);
        row = found;
        element.onEndTag(() => {
          row = undefined;
        });
      },
    })
    .on("div.table-row-v2 > div.w-embed", {
      element(element) {
        if (row && isHidden(element)) row.hidden = true;
      },
    })
    .on("div.table-row-v2 h3[data-product]", {
      element(element) {
        if (row !== undefined && row.product === "")
          row.product = element.getAttribute("data-product") ?? "";
      },
    })
    .on(ROW_CELL, {
      element() {
        row?.cells.push("");
      },
      text(chunk) {
        if (row) appendText(row.cells, chunk.text);
      },
    })
    .on(`${ROW_CELL} *`, {
      element(element) {
        if (row) appendText(row.cells, boundary(element));
      },
    })
    .transform(new Response(html))
    .text();

  return tables.map((found) => {
    const where = cleanText(found.label) || "A GPU table";
    if (found.paginated) {
      throw new Error(
        `${where}: the table is paginated, so some rows are on another page.`,
      );
    }
    return {
      label: cleanText(found.label),
      headers: found.headers.map(cleanText),
      rows: found.rows
        .filter((entry) => !entry.hidden)
        .map((entry) => ({
          product: entry.product,
          cells: entry.cells.map(cleanText),
        })),
    };
  });
}

/**
 * Turn the parsed tables into offerings: map each product through `skus`,
 * check that the page agrees with the curated data, and merge the regions.
 * Throws on anything the page layout should not produce.
 */
export function buildOfferings(
  tables: PricingTable[],
  gpus: Record<string, GpuMetadata>,
  skus: CoreWeaveSku[] = SKUS,
): CoreWeaveSyncResult {
  checkUnique(skus);
  if (tables.length === 0) {
    throw new Error(
      'Found no GPU table under an "On-demand GPU instances" heading. The page layout changed, or the response is not the pricing page.',
    );
  }

  const warnings: string[] = [];
  // product -> region slug -> row
  const listings = new Map<string, Map<string, PricingRow>>();
  const regionsSeen = new Set<string>();
  for (const table of tables) {
    const match = /^region\s*:\s*(.+)$/i.exec(table.label);
    if (match?.[1] === undefined) {
      throw new Error(
        `A GPU table has no "REGION: ..." label (found "${table.label}"). The page layout changed.`,
      );
    }
    const region = REGIONS.get(match[1].replace(FOOTNOTE, "").toLowerCase());
    if (region === undefined) {
      warnings.push(
        `"${table.label}" is not in REGIONS, so its table is skipped. Add it to REGIONS in coreweave.ts.`,
      );
      continue;
    }
    if (regionsSeen.has(region)) {
      throw new Error(`Two GPU tables map to the region "${region}".`);
    }
    if (table.rows.length === 0) {
      throw new Error(
        `${table.label}: the GPU table has no rows. If CoreWeave stopped selling there, remove "${region}" from REGIONS in coreweave.ts.`,
      );
    }
    regionsSeen.add(region);

    for (const [product, row] of readTable(table, warnings)) {
      const byRegion = listings.get(product) ?? new Map<string, PricingRow>();
      byRegion.set(region, row);
      listings.set(product, byRegion);
    }
  }

  const missingRegions = [...REGIONS.values()].filter(
    (region) => !regionsSeen.has(region),
  );
  if (missingRegions.length > 0) {
    throw new Error(
      `No GPU table maps to ${missingRegions.join(", ")}. If CoreWeave stopped selling there, remove it from REGIONS in coreweave.ts; if its label changed, update REGIONS.`,
    );
  }

  const mapped = new Set(skus.map((sku) => sku.product));
  const unmapped: string[] = [];
  for (const [product, byRegion] of listings) {
    if (mapped.has(product)) continue;
    const name = [...byRegion.values()][0]?.name ?? product;
    unmapped.push(`"${product}" (${name})`);
  }

  const missing = skus.filter((sku) => !listings.has(sku.product));
  if (missing.length > 0) {
    let message = `Not on the pricing page: ${missing.map((sku) => `"${sku.product}" (${sku.id})`).join(", ")}. If CoreWeave stopped selling a product, remove it from SKUS in coreweave.ts; if its slug changed, update SKUS.`;
    if (unmapped.length > 0) {
      message += ` Products on the page that SKUS does not map: ${unmapped.join(", ")}.`;
    }
    throw new Error(message);
  }
  for (const product of unmapped) {
    warnings.push(
      `${product} is not in SKUS, so it is skipped. Add it to SKUS in coreweave.ts.`,
    );
  }

  const offerings: CoreWeaveOffering[] = [];
  for (const sku of skus) {
    const byRegion = listings.get(sku.product);
    if (byRegion !== undefined) offerings.push(toOffering(sku, byRegion, gpus));
  }
  return { offerings, warnings };
}

export async function fetchPricingPage(): Promise<string> {
  const response = await fetch(PRICING_URL, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.headers.get("cf-mitigated") === "challenge") {
    throw new Error(
      `Cloudflare answered ${PRICING_URL} with a bot challenge. Try again later or from another network.`,
    );
  }
  if (!response.ok) {
    throw new Error(`${PRICING_URL} returned HTTP ${response.status}.`);
  }
  if (new URL(response.url).pathname.replace(/\/$/, "") !== "/pricing") {
    throw new Error(`${PRICING_URL} redirected to ${response.url}.`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) {
    throw new Error(`${PRICING_URL} returned "${type}", not HTML.`);
  }
  return response.text();
}

export async function syncCoreWeave(
  gpus: Record<string, GpuMetadata>,
): Promise<CoreWeaveSyncResult> {
  const html = await fetchPricingPage();
  return buildOfferings(await parsePricingPage(html), gpus);
}

function checkUnique(skus: CoreWeaveSku[]) {
  for (const key of ["id", "product"] as const) {
    const values = skus.map((sku) => sku[key]);
    const repeated = values.filter((value, index) => values.indexOf(value) !== index);
    if (repeated.length > 0) {
      throw new Error(`SKUS repeats the ${key} ${[...new Set(repeated)].join(", ")}.`);
    }
  }
}

/** Map one table's headers to columns and parse each row with PricingRow. */
function readTable(
  table: PricingTable,
  warnings: string[],
): Map<string, PricingRow> {
  const columns = table.headers.map((header) =>
    COLUMN_BY_KEY.get(normalize(header)),
  );
  for (const [index, column] of columns.entries()) {
    const header = table.headers[index];
    if (column === undefined) {
      warnings.push(`${table.label}: ignored the unknown column "${header}".`);
    } else if (columns.indexOf(column) !== index) {
      throw new Error(`${table.label}: the "${header}" column appears twice.`);
    }
  }
  for (const entry of COLUMNS) {
    if (entry.required && !columns.includes(entry.column)) {
      throw new Error(
        `${table.label}: the "${entry.header}" column is missing. The page layout changed. Columns found: ${table.headers.join(" | ")}`,
      );
    }
  }

  const rows = new Map<string, PricingRow>();
  for (const [index, row] of table.rows.entries()) {
    const where = `${table.label}, row ${index + 1} (${row.product || "no data-product"})`;
    if (row.product === "") {
      throw new Error(`${where}: the row has no data-product slug.`);
    }
    if (row.cells.length !== columns.length) {
      throw new Error(
        `${where}: ${row.cells.length} cells under ${columns.length} headers.`,
      );
    }
    const cells = Object.fromEntries(
      columns.flatMap((column, cell) =>
        column === undefined ? [] : [[column, row.cells[cell]] as const],
      ),
    );
    const parsed = PricingRow.safeParse(cells);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      throw new Error(`${where}: ${issues.join("; ")}`);
    }
    if (rows.has(row.product)) {
      throw new Error(`${where}: "${row.product}" is listed twice.`);
    }
    rows.set(row.product, parsed.data);
  }
  return rows;
}

function toOffering(
  sku: CoreWeaveSku,
  byRegion: Map<string, PricingRow>,
  gpus: Record<string, GpuMetadata>,
): CoreWeaveOffering {
  const listings = [...REGIONS.values()].flatMap((region) => {
    const row = byRegion.get(region);
    return row === undefined ? [] : [{ region, row }];
  });
  const first = listings[0];
  if (first === undefined) {
    throw new Error(`${sku.id}: no region lists "${sku.product}".`);
  }
  const spec = first.row;

  for (const { region, row } of listings) {
    for (const field of SPEC_FIELDS) {
      if (row[field] === spec[field]) continue;
      throw new Error(
        `${sku.id}: ${field} is ${spec[field]} in ${first.region} but ${row[field]} in ${region}. One offering cannot hold both; split the product in SKUS.`,
      );
    }
  }

  const canonical = gpus[sku.baseGpu];
  if (canonical === undefined) {
    throw new Error(`${sku.id}: the base GPU "${sku.baseGpu}" is not in gpus/.`);
  }
  const vramGb = sku.vramGb ?? canonical.vram_gb;
  if (spec.vramGb !== vramGb) {
    throw new Error(
      `${sku.id}: the page lists ${spec.vramGb} GB of VRAM per GPU, but ${sku.vramGb === undefined ? sku.baseGpu : "SKUS"} has ${vramGb} GB. Fix baseGpu, or set vramGb in SKUS.`,
    );
  }

  // The single-GPU inference price is the on-demand price split across the
  // GPUs, rounded to the cent. A mismatch means the page disagrees with
  // itself, most likely about the GPU count, and a wrong count would corrupt
  // every $/GPU/hr on the site.
  for (const { region, row } of listings) {
    if (row.onDemand === undefined || row.inferencePerGpu === undefined) {
      continue;
    }
    const perGpuCents = Math.round((row.onDemand / row.gpuCount) * 100);
    if (Math.abs(perGpuCents - Math.round(row.inferencePerGpu * 100)) > 1) {
      throw new Error(
        `${sku.id}: in ${region} the single-GPU price $${row.inferencePerGpu} is not $${row.onDemand} / ${row.gpuCount} GPUs. Check the GPU count on the page.`,
      );
    }
  }

  // A price that every region shares goes in [cost]; otherwise each region
  // keeps its own.
  const hourly = shared(listings.map(({ row }) => row.onDemand));
  const spotHourly = shared(listings.map(({ row }) => row.spot));
  let cost: OfferingCost | undefined;
  if (hourly !== undefined || spotHourly !== undefined) {
    cost = { hourly, spotHourly };
  }

  return {
    id: sku.id,
    instance: spec.name.replace(/^NVIDIA\s+/i, ""),
    baseGpu: sku.baseGpu,
    gpusPerInstance: spec.gpuCount,
    vramGb: sku.vramGb,
    vcpus: spec.vcpus,
    memoryGb: spec.memoryGb,
    // Local NVMe is sold in decimal TB (8 x 7.68 TB = 61.44 TB).
    localStorageGb: Math.round(spec.localStorageTb * 1000),
    fabric: sku.fabric,
    notes: sku.notes ?? [],
    cost,
    availability: listings.map(({ region, row }) => ({
      region,
      hourly: hourly === undefined ? row.onDemand : undefined,
      spotHourly: spotHourly === undefined ? row.spot : undefined,
    })),
  };
}

/** The value every entry has, or undefined when they differ. */
function shared(values: Array<number | undefined>): number | undefined {
  const [first, ...rest] = values;
  return rest.every((value) => value === first) ? first : undefined;
}

/**
 * The text to insert where an element starts inside a cell. Adjacent elements
 * must not run together: "4<a>1</a>" must not read as 41 GPUs. A <sup> holds a
 * footnote marker, so it reads as "^".
 */
function boundary(element: HTMLRewriterTypes.Element): string {
  return element.tagName === "sup" ? "^" : " ";
}

function isHidden(element: HTMLRewriterTypes.Element): boolean {
  const classes = (element.getAttribute("class") ?? "").split(/\s+/);
  return classes.includes("w-condition-invisible");
}

/** Header or heading text as a comparable key: "VRAM (GB)" -> "vram(gb)". */
function normalize(text: string): string {
  return cleanText(text)
    .replace(FOOTNOTE, "")
    .toLowerCase()
    .replace(/[^a-z0-9()]/g, "");
}

function cleanText(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+\d*);/gi,
    (entity: string, name: string) => {
      if (!name.startsWith("#")) return ENTITIES.get(name) ?? entity;
      const code = /^#x/i.test(name)
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
}

function appendText(parts: string[], text: string) {
  const last = parts.length - 1;
  if (last >= 0) parts[last] = `${parts[last] ?? ""}${text}`;
}
