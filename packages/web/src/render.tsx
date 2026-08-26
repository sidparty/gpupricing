/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { generateCatalog } from "@models.dev/core";
import type { GpuMetadata, GpuOffering, Provider, Region } from "@models.dev/core";
import { Fragment } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  DASH,
  escapeHtml,
  formatHourly,
  formatNumber,
  formatGpuCount,
  formatPerGpu,
  formatStorage,
  formatTflops,
  formatVram,
  formatWatts,
  sortNumber,
  titleCase,
} from "./shared.js";

const root = path.join(import.meta.dir, "..", "..", "..");
const Catalog = await generateCatalog(root);

export const Gpus = Catalog.gpus;
export const Providers = Catalog.providers;
export const Regions = Catalog.regions;

const BaseGpuRefs = await loadProviderBaseGpuRefs(root);
const ProviderLogoSvgs = new Map<string, string>();
const ManufacturerLogoSvgs = new Map<string, string>();

type ActiveSection = "gpus" | "providers" | "regions";

interface PageMetadata {
  title: string;
  description: string;
}

interface RenderedPage {
  html: string;
  metadata: PageMetadata;
}

interface Pricing {
  hourly?: number;
  perGpuHour?: number;
  spotHourly?: number;
  spotPerGpuHour?: number;
}

interface OfferingEntry {
  providerId: string;
  provider: Provider;
  offeringId: string;
  offering: GpuOffering;
  canonicalGpuId?: string;
  canonical?: GpuEntry;
  pricing: Pricing;
  regionSlugs: string[];
}

interface GpuEntry {
  id: string;
  metadata: GpuMetadata;
  manufacturerId: string;
  manufacturerName: string;
  offerings: OfferingEntry[];
  providerCount: number;
  regionCount: number;
  minPricePerGpuHour?: number;
  minSpotPerGpuHour?: number;
}

interface RegionEntry {
  id: string;
  region: Region;
  area: string;
  offerings: OfferingEntry[];
  providerCount: number;
  gpuCount: number;
  minPricePerGpuHour?: number;
}

interface RegionAreaGroup {
  area: string;
  regions: RegionEntry[];
  providerCount: number;
  gpuCount: number;
  minPricePerGpuHour?: number;
}

/**
 * One or more variants of the same GPU (the A100 40GB SXM, 80GB SXM and 80GB
 * PCIe are one family). The GPUs table lists a row per family and spreads the
 * differing specs across it; drilling in keeps every variant separate.
 * A GPU without a `family` forms a family of one, so nothing special-cases it.
 */
interface GpuFamilyEntry {
  id: string;
  name: string;
  manufacturerId: string;
  manufacturerName: string;
  gpus: GpuEntry[];
  providerCount: number;
  regionCount: number;
  minPricePerGpuHour?: number;
}

interface ManufacturerEntry {
  id: string;
  name: string;
  gpus: GpuEntry[];
  providerCount: number;
  regionCount: number;
  minPricePerGpuHour?: number;
}

interface SearchIndexItem {
  type: "gpu" | "manufacturer" | "provider" | "region";
  title: string;
  id: string;
  href: string;
  logo: string;
  tokens: string[];
  manufacturer?: string;
  providerType?: string;
  vramGb?: number;
  providerCount?: number;
  regionCount?: number;
  gpuCount?: number;
  offeringCount?: number;
  minPricePerGpuHour?: number;
  location?: string;
  updated?: string;
  description?: string;
}

const MANUFACTURER_NAMES: Record<string, string> = {
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
};

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  cloud: "Cloud",
  neocloud: "Neocloud",
  marketplace: "Marketplace",
};

// Preferred display order for top-level region areas on the regions page.
const AREA_ORDER = [
  "North America",
  "Europe",
  "Asia Pacific",
  "Middle East",
  "South America",
  "Africa",
];

const SITE_NAME = "GPU Prices";
const SITE_TAGLINE = "An open database of on-demand GPU cloud pricing";

const DEFAULT_PAGE_METADATA: PageMetadata = {
  title: `${SITE_NAME} - On-demand GPU cloud pricing`,
  description:
    "An open database of on-demand GPU instance pricing, specs, and availability across cloud providers.",
};

const GpuEntries = buildGpuEntries();
const OfferingEntries = buildOfferingEntries();
connectOfferings(GpuEntries, OfferingEntries);
const RegionEntries = buildRegionEntries();
const ManufacturerEntries = buildManufacturerEntries();
const FamilyEntries = buildFamilyEntries(sortGpus([...GpuEntries.values()]));
const SearchItems = buildSearchItems();

export const RenderedPages = buildPages();
export const Rendered = RenderedPages.get("/")!.html;

export function normalizeRoute(pathname: string) {
  if (pathname !== "/" && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function getRenderedPage(pathname: string) {
  return RenderedPages.get(normalizeRoute(pathname));
}

export function renderDocument(template: string, page: RenderedPage) {
  return template
    .replaceAll("__PAGE_TITLE__", escapeHtml(page.metadata.title))
    .replaceAll("__PAGE_DESCRIPTION__", escapeHtml(page.metadata.description))
    .replace("<!--static-->", page.html);
}

/////////////////////////
// Data assembly
/////////////////////////

async function loadProviderBaseGpuRefs(root: string) {
  const refs = new Map<string, string>();
  const providersDirectory = path.join(root, "providers");
  if (!existsSync(providersDirectory)) return refs;

  for await (const offeringPath of new Bun.Glob("*/gpus/**/*.toml").scan({
    cwd: providersDirectory,
    absolute: true,
    followSymlinks: true,
  })) {
    const parts = path.relative(providersDirectory, offeringPath).split(path.sep);
    const [providerId, gpusSegment, ...offeringParts] = parts;
    if (!providerId || gpusSegment !== "gpus" || offeringParts.length === 0) {
      continue;
    }

    const offeringId = offeringParts.join("/").slice(0, -5);
    const toml = await import(offeringPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default as { base_gpu?: unknown });

    if (typeof toml.base_gpu === "string") {
      refs.set(`${providerId}/${offeringId}`, toml.base_gpu);
    }
  }

  return refs;
}

function buildGpuEntries() {
  const entries = new Map<string, GpuEntry>();

  for (const [id, metadata] of Object.entries(Gpus)) {
    const manufacturerId = id.split("/")[0]!;
    entries.set(id, {
      id,
      metadata,
      manufacturerId,
      manufacturerName: manufacturerName(manufacturerId),
      offerings: [],
      providerCount: 0,
      regionCount: 0,
    });
  }

  return entries;
}

function resolvePricing(offering: GpuOffering, regionSlug?: string): Pricing {
  // A slug can cover several of a provider's native regions (e.g. Azure's
  // eastus and eastus2 both sit in us-east); price the cheapest of them.
  const entry = regionSlug
    ? offering.availability
        .filter((a) => a.region === regionSlug)
        .reduce<GpuOffering["availability"][number] | undefined>(
          (best, candidate) => {
            if (best === undefined) return candidate;
            const bestPrice = best.hourly ?? offering.cost?.hourly ?? Infinity;
            const price = candidate.hourly ?? offering.cost?.hourly ?? Infinity;
            return price < bestPrice ? candidate : best;
          },
          undefined,
        )
    : undefined;

  const hourly =
    entry?.hourly ??
    offering.cost?.hourly ??
    minDefined(offering.availability.map((a) => a.hourly));

  const spotHourly = regionSlug
    ? entry?.spot_hourly ?? offering.cost?.spot_hourly
    : offering.cost?.spot_hourly ??
      minDefined(offering.availability.map((a) => a.spot_hourly));

  const count = offering.gpus_per_instance;
  return {
    hourly,
    perGpuHour: hourly === undefined ? undefined : hourly / count,
    spotHourly,
    spotPerGpuHour: spotHourly === undefined ? undefined : spotHourly / count,
  };
}

function buildOfferingEntries(): OfferingEntry[] {
  const entries: OfferingEntry[] = [];

  for (const [providerId, provider] of Object.entries(Providers)) {
    for (const [offeringId, offering] of Object.entries(provider.gpus)) {
      const canonicalGpuId = resolveCanonicalGpuId(providerId, offeringId);
      entries.push({
        providerId,
        provider,
        offeringId,
        offering,
        canonicalGpuId,
        pricing: resolvePricing(offering),
        regionSlugs: offering.availability.map((a) => a.region),
      });
    }
  }

  return entries.sort(
    (a, b) =>
      a.provider.name.localeCompare(b.provider.name) ||
      a.offering.name.localeCompare(b.offering.name),
  );
}

function connectOfferings(
  gpus: Map<string, GpuEntry>,
  offerings: OfferingEntry[],
) {
  for (const entry of offerings) {
    if (!entry.canonicalGpuId) continue;
    const canonical = gpus.get(entry.canonicalGpuId);
    if (!canonical) continue;
    entry.canonical = canonical;
    canonical.offerings.push(entry);
  }

  for (const gpu of gpus.values()) {
    const providers = new Set<string>();
    const regions = new Set<string>();
    for (const offering of gpu.offerings) {
      providers.add(offering.providerId);
      for (const slug of offering.regionSlugs) regions.add(slug);
    }
    gpu.providerCount = providers.size;
    gpu.regionCount = regions.size;
    gpu.minPricePerGpuHour = minDefined(
      gpu.offerings.map((offering) => offering.pricing.perGpuHour),
    );
    gpu.minSpotPerGpuHour = minDefined(
      gpu.offerings.map((offering) => offering.pricing.spotPerGpuHour),
    );
    gpu.offerings.sort(
      (a, b) =>
        (a.pricing.perGpuHour ?? Infinity) - (b.pricing.perGpuHour ?? Infinity) ||
        a.provider.name.localeCompare(b.provider.name),
    );
  }
}

function buildRegionEntries(): RegionEntry[] {
  const buckets = new Map<string, OfferingEntry[]>();
  for (const slug of Object.keys(Regions)) buckets.set(slug, []);
  for (const offering of OfferingEntries) {
    // regionSlugs can repeat when a provider has several native regions in one
    // slug; the offering should still be listed once per region.
    for (const slug of new Set(offering.regionSlugs)) {
      if (!buckets.has(slug)) buckets.set(slug, []);
      buckets.get(slug)!.push(offering);
    }
  }

  return Object.entries(Regions)
    .map(([slug, region]) => {
      const offerings = buckets.get(slug) ?? [];
      const providers = new Set<string>();
      const gpuIds = new Set<string>();
      let minPricePerGpuHour: number | undefined;

      for (const offering of offerings) {
        providers.add(offering.providerId);
        if (offering.canonicalGpuId) gpuIds.add(offering.canonicalGpuId);
        const perGpu = resolvePricing(offering.offering, slug).perGpuHour;
        if (perGpu !== undefined) {
          minPricePerGpuHour =
            minPricePerGpuHour === undefined
              ? perGpu
              : Math.min(minPricePerGpuHour, perGpu);
        }
      }

      return {
        id: slug,
        region,
        area: region.area ?? region.name,
        offerings,
        providerCount: providers.size,
        gpuCount: gpuIds.size,
        minPricePerGpuHour,
      };
    })
    .sort((a, b) => a.region.name.localeCompare(b.region.name));
}

/**
 * Longest shared leading words across the variant names — "A100 40GB SXM",
 * "A100 SXM" and "A100 80GB PCIe" give "A100" — so a family names itself
 * instead of needing the name spelled out in data.
 */
function commonNamePrefix(names: string[], fallback: string) {
  if (names.length === 0) return fallback;
  const wordLists = names.map((name) => name.split(" "));
  const shared: string[] = [];
  for (let index = 0; index < wordLists[0]!.length; index++) {
    const word = wordLists[0]![index];
    if (wordLists.every((words) => words[index] === word)) shared.push(word!);
    else break;
  }
  return shared.length > 0 ? shared.join(" ") : fallback;
}

/** Group GPU variants into families; a GPU with no `family` stands alone. */
function buildFamilyEntries(gpus: GpuEntry[]): GpuFamilyEntry[] {
  const buckets = new Map<string, GpuEntry[]>();
  for (const gpu of gpus) {
    // Fall back to the GPU's own id so ungrouped GPUs get a family of one.
    const key = `${gpu.manufacturerId}/${gpu.metadata.family ?? gpu.id.split("/").slice(1).join("/")}`;
    const existing = buckets.get(key) ?? [];
    existing.push(gpu);
    buckets.set(key, existing);
  }

  return [...buckets.entries()].map(([key, entries]) => {
    // Order variants smallest-first so the spread reads "40 / 80 GB".
    const sorted = [...entries].sort(
      (a, b) =>
        a.metadata.vram_gb - b.metadata.vram_gb ||
        a.metadata.name.localeCompare(b.metadata.name),
    );
    const providers = new Set<string>();
    const regions = new Set<string>();
    let minPricePerGpuHour: number | undefined;
    for (const gpu of sorted) {
      for (const offering of gpu.offerings) {
        providers.add(offering.providerId);
        for (const slug of offering.regionSlugs) regions.add(slug);
      }
      minPricePerGpuHour = minValue(minPricePerGpuHour, gpu.minPricePerGpuHour);
    }
    const first = sorted[0]!;
    return {
      id: key,
      name:
        sorted.length === 1
          ? first.metadata.name
          : commonNamePrefix(
              sorted.map((gpu) => gpu.metadata.name),
              key.split("/").slice(1).join("/").toUpperCase(),
            ),
      manufacturerId: first.manufacturerId,
      manufacturerName: first.manufacturerName,
      gpus: sorted,
      providerCount: providers.size,
      regionCount: regions.size,
      minPricePerGpuHour,
    };
  });
}

/** Wrap a single GPU as a family of one so tables can render it uniformly. */
function singletonFamily(gpu: GpuEntry): GpuFamilyEntry {
  return {
    id: gpu.id,
    name: gpu.metadata.name,
    manufacturerId: gpu.manufacturerId,
    manufacturerName: gpu.manufacturerName,
    gpus: [gpu],
    providerCount: gpu.providerCount,
    regionCount: gpu.regionCount,
    minPricePerGpuHour: gpu.minPricePerGpuHour,
  };
}

/** Distinct values of one spec across a family, in variant order. */
function familyValues<T>(
  gpus: GpuEntry[],
  pick: (gpu: GpuEntry) => T | undefined,
): T[] {
  const seen: T[] = [];
  for (const gpu of gpus) {
    const value = pick(gpu);
    if (value !== undefined && !seen.includes(value)) seen.push(value);
  }
  return seen;
}

/** Group canonical GPUs by manufacturer so each gets a browsable page. */
function buildManufacturerEntries(): ManufacturerEntry[] {
  const buckets = new Map<string, GpuEntry[]>();
  for (const gpu of GpuEntries.values()) {
    const existing = buckets.get(gpu.manufacturerId) ?? [];
    existing.push(gpu);
    buckets.set(gpu.manufacturerId, existing);
  }

  return [...buckets.entries()]
    .map(([id, gpus]) => {
      const providers = new Set<string>();
      const regions = new Set<string>();
      let minPricePerGpuHour: number | undefined;
      for (const gpu of gpus) {
        for (const offering of gpu.offerings) {
          providers.add(offering.providerId);
          for (const slug of offering.regionSlugs) regions.add(slug);
        }
        minPricePerGpuHour = minValue(minPricePerGpuHour, gpu.minPricePerGpuHour);
      }
      return {
        id,
        name: manufacturerName(id),
        gpus: sortGpus(gpus),
        providerCount: providers.size,
        regionCount: regions.size,
        minPricePerGpuHour,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function groupRegionsByArea(regions: RegionEntry[]): RegionAreaGroup[] {
  const buckets = new Map<string, RegionEntry[]>();
  for (const region of regions) {
    const existing = buckets.get(region.area) ?? [];
    existing.push(region);
    buckets.set(region.area, existing);
  }

  const groups: RegionAreaGroup[] = [...buckets.entries()].map(
    ([area, entries]) => {
      const providers = new Set<string>();
      const gpuIds = new Set<string>();
      let minPricePerGpuHour: number | undefined;
      for (const region of entries) {
        for (const offering of region.offerings) {
          providers.add(offering.providerId);
          if (offering.canonicalGpuId) gpuIds.add(offering.canonicalGpuId);
        }
        minPricePerGpuHour = minValue(
          minPricePerGpuHour,
          region.minPricePerGpuHour,
        );
      }
      entries.sort((a, b) => a.region.name.localeCompare(b.region.name));
      return {
        area,
        regions: entries,
        providerCount: providers.size,
        gpuCount: gpuIds.size,
        minPricePerGpuHour,
      };
    },
  );

  return groups.sort((a, b) => {
    const ia = AREA_ORDER.indexOf(a.area);
    const ib = AREA_ORDER.indexOf(b.area);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return a.area.localeCompare(b.area);
  });
}

function resolveCanonicalGpuId(providerId: string, offeringId: string) {
  const baseGpuId = BaseGpuRefs.get(`${providerId}/${offeringId}`);
  if (baseGpuId && Gpus[baseGpuId]) return baseGpuId;
  if (Gpus[offeringId]) return offeringId;
}

function buildSearchItems(): SearchIndexItem[] {
  const items: SearchIndexItem[] = [];

  for (const gpu of sortGpus([...GpuEntries.values()])) {
    const metadata = gpu.metadata;
    items.push({
      type: "gpu",
      title: metadata.name,
      id: gpu.id,
      href: gpuHref(gpu.id),
      logo: manufacturerLogoHref(gpu.manufacturerId),
      manufacturer: gpu.manufacturerName,
      vramGb: metadata.vram_gb,
      providerCount: gpu.providerCount,
      regionCount: gpu.regionCount,
      minPricePerGpuHour: gpu.minPricePerGpuHour,
      description: metadata.description,
      updated: metadata.last_updated,
      tokens: [
        metadata.name,
        gpu.id,
        gpu.manufacturerName,
        metadata.architecture,
        metadata.memory_type,
        metadata.interconnect,
        metadata.description,
        ...gpu.offerings.flatMap((offering) => [
          offering.offering.instance,
          offering.provider.name,
          offering.providerId,
        ]),
      ].filter((token): token is string => Boolean(token)),
    });
  }

  for (const [providerId, provider] of sortedProviders()) {
    const offerings = OfferingEntries.filter(
      (entry) => entry.providerId === providerId,
    );
    const regions = new Set<string>();
    let minPrice: number | undefined;
    let updated: string | undefined;
    for (const offering of offerings) {
      for (const slug of offering.regionSlugs) regions.add(slug);
      minPrice = minValue(minPrice, offering.pricing.perGpuHour);
      updated = maxDate(updated, offering.offering.last_updated);
    }

    items.push({
      type: "provider",
      title: provider.name,
      id: providerId,
      href: providerHref(providerId),
      logo: logoHref(providerId),
      providerType: providerTypeLabel(provider.type),
      offeringCount: offerings.length,
      regionCount: regions.size,
      minPricePerGpuHour: minPrice,
      updated,
      tokens: [
        provider.name,
        providerId,
        providerTypeLabel(provider.type),
        provider.doc,
        ...offerings.map((offering) => offering.offering.name),
        ...offerings.map((offering) => offering.offering.instance),
      ].filter((token): token is string => Boolean(token)),
    });
  }

  for (const region of RegionEntries) {
    items.push({
      type: "region",
      title: region.region.name,
      id: region.id,
      href: regionHref(region.id),
      logo: defaultLogoHref(),
      location: region.region.location,
      providerCount: region.providerCount,
      gpuCount: region.gpuCount,
      minPricePerGpuHour: region.minPricePerGpuHour,
      tokens: [
        region.region.name,
        region.id,
        region.region.location,
        ...region.offerings.flatMap((offering) => [
          offering.offering.instance,
          offering.provider.name,
        ]),
      ].filter((token): token is string => Boolean(token)),
    });
  }

  for (const manufacturer of ManufacturerEntries) {
    items.push({
      type: "manufacturer",
      title: manufacturer.name,
      id: manufacturer.id,
      href: manufacturerHref(manufacturer.id),
      logo: manufacturerLogoHref(manufacturer.id),
      gpuCount: manufacturer.gpus.length,
      providerCount: manufacturer.providerCount,
      regionCount: manufacturer.regionCount,
      minPricePerGpuHour: manufacturer.minPricePerGpuHour,
      tokens: [
        manufacturer.name,
        manufacturer.id,
        ...manufacturer.gpus.map((gpu) => gpu.metadata.name),
      ].filter((token): token is string => Boolean(token)),
    });
  }

  return items;
}

/////////////////////////
// Pages
/////////////////////////

function buildPages() {
  const pages = new Map<string, RenderedPage>();
  const gpuList = sortGpus([...GpuEntries.values()]);
  const providerList = sortedProviders();

  const addPage = (route: string, page: RenderedPage) => {
    pages.set(normalizeRoute(route), page);
  };

  const home = renderPage("gpus", <GpusPage families={FamilyEntries} />);
  addPage("/", home);
  addPage("/gpus", home);
  addPage(
    "/providers",
    renderPage("providers", <ProvidersPage providers={providerList} />),
  );
  addPage(
    "/regions",
    renderPage("regions", <RegionsPage regions={RegionEntries} />),
  );

  for (const gpu of gpuList) {
    addPage(
      gpuHref(gpu.id),
      renderPage("gpus", <GpuPage gpu={gpu} />, gpuPageMetadata(gpu)),
    );
  }

  // Only multi-variant families need a page; a family of one links straight to
  // its GPU. Their routes share a namespace, so a clash must not pass silently.
  for (const family of FamilyEntries) {
    if (family.gpus.length < 2) continue;
    const route = normalizeRoute(familyHref(family));
    if (pages.has(route)) {
      throw new Error(
        `GPU family "${family.id}" collides with an existing page at ${route}. Rename the family or the GPU.`,
      );
    }
    addPage(
      route,
      renderPage(
        "gpus",
        <FamilyPage family={family} />,
        familyPageMetadata(family),
      ),
    );
  }

  for (const manufacturer of ManufacturerEntries) {
    addPage(
      manufacturerHref(manufacturer.id),
      renderPage(
        "gpus",
        <ManufacturerPage manufacturer={manufacturer} />,
        manufacturerPageMetadata(manufacturer),
      ),
    );
  }

  for (const [providerId, provider] of providerList) {
    const offerings = OfferingEntries.filter(
      (entry) => entry.providerId === providerId,
    );
    addPage(
      providerHref(providerId),
      renderPage(
        "providers",
        <ProviderPage
          providerId={providerId}
          provider={provider}
          offerings={offerings}
        />,
        providerPageMetadata(providerId, provider, offerings),
      ),
    );
  }

  for (const region of RegionEntries) {
    addPage(
      regionHref(region.id),
      renderPage("regions", <RegionPage region={region} />, regionPageMetadata(region)),
    );
  }

  return pages;
}

function renderPage(
  active: ActiveSection,
  content: unknown,
  metadata: PageMetadata = DEFAULT_PAGE_METADATA,
): RenderedPage {
  return {
    html: renderToString(
      <Fragment>
        <Header active={active} />
        <main class="page-scroll">{content}</main>
        <MobileMenu active={active} />
        <SearchDialog items={SearchItems} />
        <HelpDialog />
      </Fragment>,
    ),
    metadata,
  };
}

function gpuPageMetadata(gpu: GpuEntry): PageMetadata {
  const metadata = gpu.metadata;
  // GPU names omit the manufacturer (it has its own column), but titles and
  // descriptions are read out of context, so spell it out here.
  const fullName = `${gpu.manufacturerName} ${metadata.name}`;
  const title = `${fullName} cloud pricing and specs | ${SITE_NAME}`;
  const facts = [
    `${formatVram(metadata.vram_gb)} ${metadata.memory_type ?? "VRAM"}`.trim(),
    metadata.architecture ? `${metadata.architecture} architecture` : undefined,
    gpu.minPricePerGpuHour !== undefined
      ? `from ${formatPerGpu(gpu.minPricePerGpuHour)}/GPU/hr`
      : undefined,
  ].filter(Boolean);
  const description = compact(
    [
      metadata.description,
      `Compare on-demand ${fullName} pricing across ${plural(gpu.providerCount, "provider")} and ${plural(gpu.regionCount, "region")}.`,
      facts.length ? `Specs: ${facts.join(", ")}.` : undefined,
    ],
    280,
  );
  return { title, description };
}

function providerPageMetadata(
  providerId: string,
  provider: Provider,
  offerings: OfferingEntry[],
): PageMetadata {
  const title = `${provider.name} GPU pricing and instances | ${SITE_NAME}`;
  const description = compact(
    [
      `Browse ${plural(offerings.length, `${provider.name} GPU instance`)} with on-demand and spot hourly pricing.`,
      `${provider.name} is a ${providerTypeLabel(provider.type).toLowerCase()} GPU provider.`,
      `Provider ID: ${providerId}.`,
    ],
    280,
  );
  return { title, description };
}

function familyPageMetadata(family: GpuFamilyEntry): PageMetadata {
  const fullName = `${family.manufacturerName} ${family.name}`;
  const variants = family.gpus.map((gpu) => gpu.metadata.name).join(", ");
  return {
    title: `${fullName} cloud pricing and specs | ${SITE_NAME}`,
    description: compact(
      [
        `Compare on-demand ${fullName} pricing across ${plural(family.providerCount, "provider")} and ${plural(family.regionCount, "region")}.`,
        `Variants: ${variants}.`,
      ],
      280,
    ),
  };
}

function manufacturerPageMetadata(
  manufacturer: ManufacturerEntry,
): PageMetadata {
  const title = `${manufacturer.name} GPU cloud pricing | ${SITE_NAME}`;
  const description = compact(
    [
      `Compare on-demand cloud pricing for ${plural(manufacturer.gpus.length, `${manufacturer.name} GPU`)} across ${plural(manufacturer.providerCount, "provider")} and ${plural(manufacturer.regionCount, "region")}.`,
      manufacturer.minPricePerGpuHour !== undefined
        ? `From ${formatPerGpu(manufacturer.minPricePerGpuHour)}/GPU/hr.`
        : undefined,
    ],
    280,
  );
  return { title, description };
}

function regionPageMetadata(region: RegionEntry): PageMetadata {
  const title = `GPU pricing in ${region.region.name} | ${SITE_NAME}`;
  const description = compact(
    [
      `On-demand GPU instances available in ${region.region.name}${region.region.location ? ` (${region.region.location})` : ""}.`,
      `${plural(region.providerCount, "provider")}, ${plural(region.gpuCount, "GPU model")}${
        region.minPricePerGpuHour !== undefined
          ? `, from ${formatPerGpu(region.minPricePerGpuHour)}/GPU/hr`
          : ""
      }.`,
    ],
    280,
  );
  return { title, description };
}

function GpusPage(props: { families: GpuFamilyEntry[] }) {
  return <GpuTable families={props.families} title="GPUs" hideHeading />;
}

function GpuTable(props: {
  families: GpuFamilyEntry[];
  title: string;
  hideHeading?: boolean;
  showManufacturer?: boolean;
}) {
  const showManufacturer = props.showManufacturer ?? true;
  const columns = showManufacturer ? 9 : 8;
  return (
    <TableSection
      title={props.title}
      count={props.families.length}
      columns={columns}
      hideHeading={props.hideHeading}
    >
      <table data-enhanced-table>
        <thead>
          <tr>
            <SortableTh>GPU</SortableTh>
            {showManufacturer && <SortableTh>Manufacturer</SortableTh>}
            <SortableTh>Architecture</SortableTh>
            <SortableTh type="number">VRAM</SortableTh>
            <SortableTh>Memory</SortableTh>
            <SortableTh>Interconnect</SortableTh>
            <SortableTh type="number">Providers</SortableTh>
            <SortableTh type="number">Regions</SortableTh>
            <SortableTh type="number">Best $/GPU/hr</SortableTh>
          </tr>
        </thead>
        <tbody>
          {props.families.map((family) => {
            const single = family.gpus.length === 1 ? family.gpus[0] : undefined;
            const href = single ? gpuHref(single.id) : familyHref(family);
            const vram = familyValues(family.gpus, (gpu) => gpu.metadata.vram_gb);
            const architecture = familyValues(
              family.gpus,
              (gpu) => gpu.metadata.architecture,
            );
            const memory = familyValues(
              family.gpus,
              (gpu) => gpu.metadata.memory_type,
            );
            const interconnect = familyValues(
              family.gpus,
              (gpu) => gpu.metadata.interconnect,
            );

            return (
              <tr
                data-search={`${family.name} ${family.manufacturerName} ${family.gpus.map((gpu) => `${gpu.metadata.name} ${gpu.id}`).join(" ")} ${architecture.join(" ")} ${memory.join(" ")} ${interconnect.join(" ")}`}
              >
                <td data-sort={family.name}>
                  <a class="primary-link" href={href}>
                    {family.name}
                  </a>
                  <span class="subtle mono">
                    {single
                      ? single.id
                      : plural(family.gpus.length, "variant")}
                  </span>
                </td>
                {showManufacturer && (
                  <td data-sort={family.manufacturerName}>
                    <ManufacturerLink
                      manufacturerId={family.manufacturerId}
                      manufacturerName={family.manufacturerName}
                    />
                  </td>
                )}
                <td data-sort={architecture[0] ?? ""}>
                  {architecture.join(" / ") || DASH}
                </td>
                {/* Numeric specs sort on the family's best, prices on its cheapest. */}
                <td data-sort={sortNumber(maxDefined(vram))}>
                  {vram.length > 0
                    ? `${vram.map((value) => formatNumber(value)).join(" / ")} GB`
                    : DASH}
                </td>
                <td data-sort={memory[0] ?? ""}>{memory.join(" / ") || DASH}</td>
                <td data-sort={interconnect[0] ?? ""}>
                  {interconnect.join(" / ") || DASH}
                </td>
                <td data-sort={String(family.providerCount)}>
                  {family.providerCount}
                </td>
                <td data-sort={String(family.regionCount)}>
                  {family.regionCount}
                </td>
                <td data-sort={sortNumber(family.minPricePerGpuHour)}>
                  {formatPerGpu(family.minPricePerGpuHour)}
                </td>
              </tr>
            );
          })}
          <EmptyRow columns={columns} />
        </tbody>
      </table>
    </TableSection>
  );
}

function ProvidersPage(props: { providers: Array<[string, Provider]> }) {
  return (
    <TableSection
      title="Providers"
      count={props.providers.length}
      columns={6}
      hideHeading
    >
      <table data-enhanced-table>
        <thead>
          <tr>
            <SortableTh>Provider</SortableTh>
            <SortableTh>Type</SortableTh>
            <SortableTh type="number">GPU instances</SortableTh>
            <SortableTh type="number">Regions</SortableTh>
            <SortableTh type="number">Min $/GPU/hr</SortableTh>
            <SortableTh>Docs</SortableTh>
          </tr>
        </thead>
        <tbody>
          {props.providers.map(([providerId, provider]) => {
            const offerings = OfferingEntries.filter(
              (entry) => entry.providerId === providerId,
            );
            const regions = new Set<string>();
            let minPrice: number | undefined;
            for (const offering of offerings) {
              for (const slug of offering.regionSlugs) regions.add(slug);
              minPrice = minValue(minPrice, offering.pricing.perGpuHour);
            }

            return (
              <tr
                data-search={`${provider.name} ${providerId} ${providerTypeLabel(provider.type)}`}
              >
                <td data-sort={provider.name}>
                  <ProviderLink providerId={providerId} provider={provider} />
                </td>
                <td data-sort={providerTypeLabel(provider.type)}>
                  {providerTypeLabel(provider.type)}
                </td>
                <td data-sort={String(offerings.length)}>{offerings.length}</td>
                <td data-sort={String(regions.size)}>{regions.size}</td>
                <td data-sort={sortNumber(minPrice)}>{formatPerGpu(minPrice)}</td>
                <td>
                  <a href={provider.doc} target="_blank" rel="noopener noreferrer">
                    Docs
                  </a>
                </td>
              </tr>
            );
          })}
          <EmptyRow columns={6} />
        </tbody>
      </table>
    </TableSection>
  );
}

function RegionsPage(props: { regions: RegionEntry[] }) {
  const groups = groupRegionsByArea(props.regions);
  return (
    <section class="table-section">
      <div class="region-groups">
        {groups.map((group) => (
          <details class="region-group">
            <summary class="region-group-summary">
              <span class="region-group-name">{group.area}</span>
              <span class="region-group-meta">
                {[
                  plural(group.regions.length, "region"),
                  plural(group.providerCount, "provider"),
                  plural(group.gpuCount, "GPU model"),
                  group.minPricePerGpuHour !== undefined
                    ? `from ${formatPerGpu(group.minPricePerGpuHour)}/GPU/hr`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </summary>
            <div class="table-wrap">
              <table class="region-subtable">
                <thead>
                  <tr>
                    <th scope="col">Region</th>
                    <th scope="col">Providers</th>
                    <th scope="col">GPU models</th>
                    <th scope="col">Min $/GPU/hr</th>
                  </tr>
                </thead>
                <tbody>
                  {group.regions.map((region) => (
                    <tr>
                      <td>
                        <a class="primary-link" href={regionHref(region.id)}>
                          {region.region.name}
                        </a>
                        <span class="subtle mono">{region.id}</span>
                      </td>
                      <td>{region.providerCount}</td>
                      <td>{region.gpuCount}</td>
                      <td>{formatPerGpu(region.minPricePerGpuHour)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function GpuPage(props: { gpu: GpuEntry }) {
  const { gpu } = props;
  const metadata = gpu.metadata;
  const compute = metadata.compute;

  return (
    <Fragment>
      <DetailHeader
        eyebrow={
          <Fragment>
            <a href="/gpus">GPUs</a>
            <span>/</span>
            <a href={manufacturerHref(gpu.manufacturerId)}>
              {gpu.manufacturerName}
            </a>
          </Fragment>
        }
        title={metadata.name}
        description={metadata.description}
        code={gpu.id}
        copyValue={gpu.id}
      />
      <Facts
        items={[
          [
            "Manufacturer",
            <ManufacturerLink
              manufacturerId={gpu.manufacturerId}
              manufacturerName={gpu.manufacturerName}
            />,
          ],
          ["Architecture", metadata.architecture ?? DASH],
          ["VRAM", formatVram(metadata.vram_gb)],
          ["Memory", metadata.memory_type ?? DASH],
          [
            "Bandwidth",
            metadata.memory_bandwidth_gbs !== undefined
              ? `${formatNumber(metadata.memory_bandwidth_gbs)} GB/s`
              : DASH,
          ],
          ["TDP", formatWatts(metadata.tdp_watts)],
          ["Interconnect", metadata.interconnect ?? DASH],
          ["FP16", formatTflops(compute?.fp16)],
          ["BF16", formatTflops(compute?.bf16)],
          ["FP8", formatTflops(compute?.fp8)],
          ["INT8 TOPS", formatTflops(compute?.int8)],
          ["Providers", gpu.providerCount],
          ["Regions", gpu.regionCount],
          ["Best $/GPU/hr", formatPerGpu(gpu.minPricePerGpuHour)],
          ["Released", metadata.release_date ?? DASH],
        ]}
      />
      <TableSection
        id="offerings"
        title="Offerings"
        count={gpu.offerings.reduce(
          (total, entry) => total + entry.offering.availability.length,
          0,
        )}
        columns={15}
      >
        <OfferingTable
          offerings={gpu.offerings}
          mode="by-provider"
          splitByRegion
        />
      </TableSection>
    </Fragment>
  );
}

function ProviderPage(props: {
  providerId: string;
  provider: Provider;
  offerings: OfferingEntry[];
}) {
  const regions = new Set<string>();
  let minPrice: number | undefined;
  for (const offering of props.offerings) {
    for (const slug of offering.regionSlugs) regions.add(slug);
    minPrice = minValue(minPrice, offering.pricing.perGpuHour);
  }

  return (
    <Fragment>
      <DetailHeader
        eyebrow={<a href="/providers">Providers</a>}
        title={props.provider.name}
        code={props.providerId}
        copyValue={props.providerId}
      />
      <Facts
        items={[
          ["Type", providerTypeLabel(props.provider.type)],
          ["GPU instances", props.offerings.length],
          ["Regions", regions.size],
          ["Min $/GPU/hr", formatPerGpu(minPrice)],
          [
            "API",
            props.provider.api ? (
              <span class="mono">{props.provider.api}</span>
            ) : (
              DASH
            ),
          ],
          [
            "Docs",
            <a href={props.provider.doc} target="_blank" rel="noopener noreferrer">
              Provider docs
            </a>,
          ],
        ]}
      />
      <TableSection
        title="Offerings"
        count={props.offerings.length}
        columns={15}
      >
        <OfferingTable offerings={props.offerings} mode="by-gpu" />
      </TableSection>
    </Fragment>
  );
}

function FamilyPage(props: { family: GpuFamilyEntry }) {
  const { family } = props;
  return (
    <Fragment>
      <DetailHeader
        eyebrow={
          <Fragment>
            <a href="/gpus">GPUs</a>
            <span>/</span>
            <a href={manufacturerHref(family.manufacturerId)}>
              {family.manufacturerName}
            </a>
          </Fragment>
        }
        title={family.name}
        code={family.id}
        copyValue={family.id}
      />
      <Facts
        items={[
          ["Variants", family.gpus.length],
          ["Providers", family.providerCount],
          ["Regions", family.regionCount],
          ["Best $/GPU/hr", formatPerGpu(family.minPricePerGpuHour)],
        ]}
      />
      {/* Each variant as its own family of one, so the table shows exact specs. */}
      <GpuTable
        families={family.gpus.map((gpu) => singletonFamily(gpu))}
        title="Variants"
        showManufacturer={false}
      />
    </Fragment>
  );
}

function ManufacturerPage(props: { manufacturer: ManufacturerEntry }) {
  const { manufacturer } = props;
  return (
    <Fragment>
      <DetailHeader
        eyebrow={<a href="/gpus">GPUs</a>}
        title={manufacturer.name}
        code={manufacturer.id}
        copyValue={manufacturer.id}
      />
      <Facts
        items={[
          ["GPUs", manufacturer.gpus.length],
          ["Providers", manufacturer.providerCount],
          ["Regions", manufacturer.regionCount],
          ["Best $/GPU/hr", formatPerGpu(manufacturer.minPricePerGpuHour)],
        ]}
      />
      <GpuTable
        families={buildFamilyEntries(manufacturer.gpus)}
        title="GPUs"
        showManufacturer={false}
      />
    </Fragment>
  );
}

function RegionPage(props: { region: RegionEntry }) {
  const { region } = props;
  return (
    <Fragment>
      <DetailHeader
        eyebrow={<a href="/regions">Regions</a>}
        title={region.region.name}
        code={region.id}
        copyValue={region.id}
      />
      <Facts
        items={[
          ["Area", region.area],
          ["Providers", region.providerCount],
          ["GPU models", region.gpuCount],
          ["Instances", region.offerings.length],
          ["Min $/GPU/hr", formatPerGpu(region.minPricePerGpuHour)],
        ]}
      />
      <TableSection
        title="Offerings"
        count={region.offerings.length}
        columns={15}
      >
        <OfferingTable
          offerings={region.offerings}
          mode="by-provider"
          regionSlug={region.id}
          splitByRegion
        />
      </TableSection>
    </Fragment>
  );
}

type AvailabilityEntry = GpuOffering["availability"][number];

function OfferingTable(props: {
  offerings: OfferingEntry[];
  mode: "by-provider" | "by-gpu";
  regionSlug?: string;
  splitByRegion?: boolean;
}) {
  const byProvider = props.mode === "by-provider";
  const split = props.splitByRegion === true;
  const columns = 15;

  // In split mode each offering expands to one row per region it's available in.
  // In split mode each offering expands to one row per region it's available
  // in — scoped to a single slug on a region page, where a provider may have
  // several native regions (e.g. Azure eastus and eastus2 in us-east).
  const rows: Array<{ entry: OfferingEntry; availability?: AvailabilityEntry }> =
    split
      ? props.offerings.flatMap((entry) =>
          entry.offering.availability
            .filter(
              (availability) =>
                props.regionSlug === undefined ||
                availability.region === props.regionSlug,
            )
            .map((availability) => ({ entry, availability })),
        )
      : props.offerings.map((entry) => ({ entry }));

  return (
    <table data-enhanced-table>
      <thead>
        <tr>
          {byProvider ? (
            <SortableTh>Provider</SortableTh>
          ) : (
            <SortableTh>GPU</SortableTh>
          )}
          <SortableTh>Instance</SortableTh>
          {split && <SortableTh>Region</SortableTh>}
          <SortableTh type="number">GPUs</SortableTh>
          <SortableTh type="number">VRAM/GPU</SortableTh>
          <SortableTh type="number">Total VRAM</SortableTh>
          <SortableTh type="number">vCPUs</SortableTh>
          <SortableTh type="number">RAM</SortableTh>
          <SortableTh type="number">Storage</SortableTh>
          <SortableTh>Interconnect</SortableTh>
          <SortableTh>Fabric</SortableTh>
          <SortableTh type="number">$/hr</SortableTh>
          <SortableTh type="number">$/GPU/hr</SortableTh>
          <SortableTh type="number">Spot $/hr</SortableTh>
          <SortableTh type="number">Spot $/GPU/hr</SortableTh>
          {!split && <SortableTh>Regions</SortableTh>}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ entry, availability }) => {
          const offering = entry.offering;
          const rowRegion = availability?.region ?? props.regionSlug;
          const pricing = resolvePricing(offering, rowRegion);
          const totalVram = offering.vram_gb * offering.gpus_per_instance;
          const regionLabels = offering.availability
            .map((a) => regionName(a.region))
            .join(", ");
          const regionTitle = offering.availability
            .map((a) => a.provider_region ?? regionName(a.region))
            .join(", ");
          const rowRegionName = availability ? regionName(availability.region) : "";

          return (
            <tr
              data-search={`${entry.provider.name} ${offering.name} ${offering.instance} ${offering.interconnect ?? ""} ${offering.fabric ?? ""} ${rowRegionName}`}
            >
              {byProvider ? (
                <td data-sort={entry.provider.name}>
                  <ProviderLink
                    providerId={entry.providerId}
                    provider={entry.provider}
                  />
                </td>
              ) : (
                <td data-sort={offering.name}>
                  {entry.canonical ? (
                    <a class="primary-link" href={gpuHref(entry.canonical.id)}>
                      {offering.name}
                    </a>
                  ) : (
                    <span>{offering.name}</span>
                  )}
                  {entry.canonicalGpuId && (
                    <span class="subtle mono">{entry.canonicalGpuId}</span>
                  )}
                </td>
              )}
              <td data-sort={offering.instance}>
                <span class="mono">{offering.instance}</span>
              </td>
              {split && availability && (
                <td data-sort={rowRegionName}>
                  <a href={regionHref(availability.region)}>{rowRegionName}</a>
                  {availability.provider_region && (
                    <span class="subtle mono">{availability.provider_region}</span>
                  )}
                </td>
              )}
              <td data-sort={sortNumber(offering.gpus_per_instance)}>
                {formatGpuCount(offering.gpus_per_instance)}
              </td>
              <td data-sort={sortNumber(offering.vram_gb)}>
                {formatVram(offering.vram_gb)}
              </td>
              <td data-sort={sortNumber(totalVram)}>{formatVram(totalVram)}</td>
              <td data-sort={sortNumber(offering.vcpus)}>
                {formatNumber(offering.vcpus)}
              </td>
              <td data-sort={sortNumber(offering.memory_gb)}>
                {offering.memory_gb === undefined
                  ? DASH
                  : `${formatNumber(offering.memory_gb)} GB`}
              </td>
              <td data-sort={sortNumber(offering.local_storage_gb)}>
                {formatStorage(offering.local_storage_gb)}
              </td>
              <td data-sort={offering.interconnect ?? ""}>
                {offering.interconnect ?? DASH}
              </td>
              <td data-sort={offering.fabric ?? ""}>{offering.fabric ?? DASH}</td>
              <td data-sort={sortNumber(pricing.hourly)}>
                {formatHourly(pricing.hourly)}
              </td>
              <td data-sort={sortNumber(pricing.perGpuHour)}>
                {formatPerGpu(pricing.perGpuHour)}
              </td>
              <td data-sort={sortNumber(pricing.spotHourly)}>
                {pricing.spotHourly === undefined
                  ? DASH
                  : formatHourly(pricing.spotHourly)}
              </td>
              <td data-sort={sortNumber(pricing.spotPerGpuHour)}>
                {formatPerGpu(pricing.spotPerGpuHour)}
              </td>
              {!split && (
                <td data-sort={regionLabels} title={regionTitle}>
                  {regionLabels || DASH}
                </td>
              )}
            </tr>
          );
        })}
        <EmptyRow columns={columns} />
      </tbody>
    </table>
  );
}

/////////////////////////
// Shared components
/////////////////////////

function Header(props: { active: ActiveSection }) {
  return (
    <header>
      <div class="left">
        <a class="brand" href="/">
          <h1>{SITE_NAME}</h1>
        </a>
        <span class="slash"></span>
        <p>{SITE_TAGLINE}</p>
      </div>
      <div class="right">
        <nav class="top-nav" aria-label="Primary">
          <a class={props.active === "gpus" ? "active" : ""} href="/gpus">
            GPUs
          </a>
          <a
            class={props.active === "providers" ? "active" : ""}
            href="/providers"
          >
            Providers
          </a>
          <a class={props.active === "regions" ? "active" : ""} href="/regions">
            Regions
          </a>
        </nav>
        <a
          class="github"
          target="_blank"
          rel="noopener noreferrer"
          href="https://github.com/sidparty/gpupricing"
          aria-label="GitHub"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
          >
            <path
              fill="currentColor"
              d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2"
            ></path>
          </svg>
        </a>
        <div class="search-container">
          <button
            type="button"
            id="search-trigger"
            class="search-trigger"
            aria-label="Search"
            aria-keyshortcuts="Control+F Meta+F Control+K Meta+K"
            aria-haspopup="dialog"
            aria-controls="search-modal"
          >
            <span class="search-trigger-label">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <path d="m21 21-4.35-4.35"></path>
              </svg>
              <span>Search</span>
            </span>
            <span class="search-shortcut">Ctrl F</span>
          </button>
        </div>
        <button id="help">How to use</button>
        <button
          type="button"
          id="mobile-menu-trigger"
          class="mobile-menu-trigger"
          aria-label="Open menu"
          aria-haspopup="dialog"
          aria-controls="mobile-menu"
          aria-expanded="false"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <line x1="4" y1="6" x2="20" y2="6"></line>
            <line x1="4" y1="12" x2="20" y2="12"></line>
            <line x1="4" y1="18" x2="20" y2="18"></line>
          </svg>
        </button>
      </div>
    </header>
  );
}

function DetailHeader(props: {
  eyebrow: unknown;
  title: string;
  description?: string;
  code: string;
  copyValue: string;
}) {
  return (
    <section class="detail-header">
      <div class="breadcrumbs">{props.eyebrow}</div>
      <h2>{props.title}</h2>
      {props.description && <p>{props.description}</p>}
      <div class="code-line">
        <code>{props.code}</code>
        <CopyButton value={props.copyValue} label={`Copy ${props.code}`} />
      </div>
    </section>
  );
}

function Facts(props: { items: Array<[string, unknown]> }) {
  return (
    <dl class="fact-grid">
      {props.items.map(([label, value]) => (
        <div>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TableSection(props: {
  id?: string;
  title: string;
  count: number;
  columns: number;
  hideHeading?: boolean;
  children: unknown;
}) {
  return (
    <section class="table-section" id={props.id}>
      {!props.hideHeading && (
        <div class="section-heading">
          <h3>{props.title}</h3>
          <span>{formatNumber(props.count)}</span>
        </div>
      )}
      <div class="table-wrap">{props.children}</div>
      <p class="empty-message">No rows match the current search.</p>
    </section>
  );
}

function SortableTh(props: { type?: "text" | "number"; children: unknown }) {
  return (
    <th class="sortable" data-type={props.type ?? "text"} scope="col">
      {props.children} <span class="sort-indicator"></span>
    </th>
  );
}

function EmptyRow(props: { columns: number }) {
  return (
    <tr class="empty-row">
      <td colspan={props.columns}>No rows match the current search.</td>
    </tr>
  );
}

function ManufacturerLink(props: {
  manufacturerId: string;
  manufacturerName: string;
}) {
  return (
    <a class="manufacturer-link" href={manufacturerHref(props.manufacturerId)}>
      <span
        class="manufacturer-logo"
        dangerouslySetInnerHTML={{
          __html: manufacturerLogoSvg(props.manufacturerId),
        }}
      />
      <span>{props.manufacturerName}</span>
    </a>
  );
}

function ProviderLink(props: {
  providerId: string;
  provider: Pick<Provider, "name">;
}) {
  return (
    <a class="provider-link" href={providerHref(props.providerId)}>
      <span
        class="provider-logo"
        dangerouslySetInnerHTML={{ __html: providerLogoSvg(props.providerId) }}
      />
      <span>{props.provider.name}</span>
    </a>
  );
}

function CopyButton(props: { value: string; label: string }) {
  return (
    <button
      type="button"
      class="copy-button"
      data-copy-value={props.value}
      aria-label={props.label}
      title={props.label}
    >
      <svg
        class="copy-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
        <path d="m4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
      </svg>
      <svg
        class="check-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="display: none;"
      >
        <polyline points="20,6 9,17 4,12"></polyline>
      </svg>
    </button>
  );
}

function MobileMenu(props: { active: ActiveSection }) {
  return (
    <dialog
      id="mobile-menu"
      class="mobile-menu"
      aria-labelledby="mobile-menu-title"
    >
      <div class="header">
        <h2 id="mobile-menu-title">Menu</h2>
        <button type="button" id="mobile-menu-close" aria-label="Close menu">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
            <line
              x1="6"
              y1="6"
              x2="18"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <nav class="mobile-menu-list" aria-label="Mobile">
        <a class={props.active === "gpus" ? "active" : ""} href="/gpus">
          GPUs
        </a>
        <a
          class={props.active === "providers" ? "active" : ""}
          href="/providers"
        >
          Providers
        </a>
        <a class={props.active === "regions" ? "active" : ""} href="/regions">
          Regions
        </a>
        <button type="button" id="mobile-search-trigger">
          Search
        </button>
        <a
          target="_blank"
          rel="noopener noreferrer"
          href="https://github.com/sidparty/gpupricing"
        >
          GitHub
        </a>
        <button type="button" id="mobile-help-trigger">
          How to use
        </button>
      </nav>
    </dialog>
  );
}

function SearchDialog(props: { items: SearchIndexItem[] }) {
  const json = JSON.stringify(props.items).replace(/</g, "\\u003c");

  return (
    <dialog
      id="search-modal"
      class="search-modal"
      aria-labelledby="search-modal-title"
    >
      <div class="search-field">
        <svg
          class="search-field-icon"
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <input
          id="search-input"
          type="text"
          placeholder="Search GPUs, providers, and regions"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-autocomplete="list"
        />
        <span class="search-escape">Esc</span>
      </div>
      <h2 id="search-modal-title" class="sr-only">
        Search
      </h2>
      <div id="search-count" class="search-count"></div>
      <div id="search-results" class="search-results" role="listbox"></div>
      <p id="search-empty" class="search-empty">No matching results.</p>
      <script
        id="search-index"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: json }}
      />
    </dialog>
  );
}

function HelpDialog() {
  return (
    <dialog id="modal">
      <div class="header">
        <h2>How to use</h2>
        <button id="close" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
            <line
              x1="6"
              y1="6"
              x2="18"
              y2="18"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <div class="body">
        <p>
          <a href="/">{SITE_NAME}</a> is an open database of on-demand GPU cloud
          pricing, specs, and availability.
        </p>
        <p>
          The homepage lists canonical GPUs with the best per-GPU hourly price
          across providers. GPU pages list every provider offering that GPU;
          provider pages list a provider's instances; region pages group
          offerings by geography. All prices are per instance per hour; the
          per-GPU price divides by the instance's GPU count.
        </p>
        <h2>API</h2>
        <p>Access the catalog through JSON endpoints.</p>
        <div class="code-block">
          <code>
            curl <a href="/api.json">/api.json</a>
          </code>
        </div>
        <div class="code-block">
          <code>
            curl <a href="/gpus.json">/gpus.json</a>
          </code>
        </div>
        <div class="code-block">
          <code>
            curl <a href="/catalog.json">/catalog.json</a>
          </code>
        </div>
        <h2>Logos</h2>
        <p>
          Provider logos are available at <code>/logos/{`{provider}`}.svg</code>{" "}
          where <code>{`{provider}`}</code> is the provider ID.
        </p>
        <h2>Contribute</h2>
        <p>
          The data is stored as TOML files: canonical GPUs in <code>gpus/</code>,
          provider offerings in <code>providers/</code>, and regions in{" "}
          <code>regions/</code>.
        </p>
      </div>
      <div class="footer">
        <a
          href="https://github.com/sidparty/gpupricing"
          target="_blank"
          rel="noopener noreferrer"
        >
          Edit on GitHub
        </a>
      </div>
    </dialog>
  );
}

/////////////////////////
// Helpers
/////////////////////////

function sortGpus(gpus: GpuEntry[]) {
  return [...gpus].sort((a, b) => {
    const released = (b.metadata.release_date ?? "").localeCompare(
      a.metadata.release_date ?? "",
    );
    if (released !== 0) return released;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

function sortedProviders(): Array<[string, Provider]> {
  return Object.entries(Providers).sort(([, a], [, b]) =>
    a.name.localeCompare(b.name),
  );
}

function minDefined(values: Array<number | undefined>) {
  let result: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (result === undefined || value < result) result = value;
  }
  return result;
}

function maxDefined(values: number[]) {
  return values.length === 0 ? undefined : Math.max(...values);
}

function minValue(current: number | undefined, next: number | undefined) {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return Math.min(current, next);
}

function maxDate(current: string | undefined, next: string | undefined) {
  if (!next) return current;
  if (!current || next > current) return next;
  return current;
}

function manufacturerName(id: string) {
  return MANUFACTURER_NAMES[id] ?? titleCase(id);
}

function providerTypeLabel(type: Provider["type"]) {
  return PROVIDER_TYPE_LABELS[type] ?? titleCase(type);
}

function regionName(slug: string) {
  return Regions[slug]?.name ?? slug;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function compact(parts: Array<string | undefined>, maxLength: number) {
  const compacted = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(" ");

  if (compacted.length <= maxLength) return compacted;
  const shortened = compacted.slice(0, maxLength - 1);
  const lastBreak = Math.max(
    shortened.lastIndexOf("."),
    shortened.lastIndexOf(","),
  );
  const trimmed = (
    lastBreak > maxLength * 0.6 ? shortened.slice(0, lastBreak) : shortened
  ).trim();
  return `${trimmed.replace(/[.,;:]$/, "")}.`;
}

function encodedPath(id: string) {
  return id.split("/").map(encodeURIComponent).join("/");
}

function gpuHref(id: string) {
  return `/gpus/${encodedPath(id)}`;
}

/** Manufacturers sit above their GPUs: /gpus/nvidia lists every NVIDIA GPU. */
function manufacturerHref(id: string) {
  return `/gpus/${encodeURIComponent(id)}`;
}

/** Families sit beside their variants: /gpus/nvidia/a100 lists the A100s. */
function familyHref(family: GpuFamilyEntry) {
  return `/gpus/${encodedPath(family.id)}`;
}

function providerHref(id: string) {
  return `/providers/${encodeURIComponent(id)}`;
}

function regionHref(id: string) {
  return `/regions/${encodeURIComponent(id)}`;
}

function logoHref(providerId: string) {
  return `/logos/${encodeURIComponent(providerId)}.svg`;
}

function defaultLogoHref() {
  return "/logos/default.svg";
}

function manufacturerLogoHref(manufacturerId: string) {
  return `/logos/gpus/${encodeURIComponent(manufacturerId)}.svg`;
}

/** Manufacturer marks live at gpus/<manufacturer>/logo.svg. */
function manufacturerLogoSvg(manufacturerId: string) {
  const cached = ManufacturerLogoSvgs.get(manufacturerId);
  if (cached) return cached;

  const logoPath = path.join(root, "gpus", manufacturerId, "logo.svg");
  const defaultLogoPath = path.join(root, "providers", "logo.svg");
  const svg = normalizeLogoSvg(
    readFileSync(existsSync(logoPath) ? logoPath : defaultLogoPath, "utf8"),
  );

  ManufacturerLogoSvgs.set(manufacturerId, svg);
  return svg;
}

/** Strip fixed sizing and force theme-adaptive colors. */
function normalizeLogoSvg(rawSvg: string) {
  return rawSvg
    .replace(/<svg\b([^>]*)>/i, (_, attributes: string) => {
      const cleaned = attributes.replace(/\s(width|height)="[^"]*"/gi, "");
      return `<svg${cleaned} aria-hidden="true" focusable="false">`;
    })
    .replace(/\sfill="(?!none|currentColor)[^"]*"/gi, ' fill="currentColor"')
    .replace(/\sstroke="(?!none|currentColor)[^"]*"/gi, ' stroke="currentColor"');
}

function providerLogoSvg(providerId: string) {
  const cached = ProviderLogoSvgs.get(providerId);
  if (cached) return cached;

  const logoPath = path.join(root, "providers", providerId, "logo.svg");
  const defaultLogoPath = path.join(root, "providers", "logo.svg");
  const svg = normalizeLogoSvg(
    readFileSync(existsSync(logoPath) ? logoPath : defaultLogoPath, "utf8"),
  );

  ProviderLogoSvgs.set(providerId, svg);
  return svg;
}
