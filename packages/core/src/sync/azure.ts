/**
 * Azure GPU price sync.
 *
 * Pulls per-instance, per-region hourly pricing from the public Azure Retail
 * Prices API (https://prices.azure.com/api/retail/prices — no auth) and maps it
 * onto our offering shape. Two curated tables keep the mapping honest:
 *   - INSTANCES: which VM SKU is which GPU, and how many (the API doesn't say).
 *   - AZURE_REGIONS: Azure region code -> our normalized region slug + area.
 * Prices always come live from the API; only the mappings are hand-maintained.
 */

export interface AzureInstance {
  /** Azure ARM SKU name, e.g. "Standard_ND96isr_H100_v5". */
  armSkuName: string;
  /** Offering file id under providers/azure/gpus/. */
  id: string;
  /** Display instance name. */
  instance: string;
  /** Canonical GPU id under gpus/. */
  baseGpu: string;
  gpusPerInstance: number;
  vcpus?: number;
  memoryGb?: number;
  fabric?: string;
}

export interface AzureRegion {
  slug: string;
  name: string;
  area: string;
}

export interface OfferingAvailability {
  region: string;
  providerRegion: string;
  hourly: number;
  spotHourly?: number;
}

export interface AzureOffering {
  id: string;
  instance: string;
  baseGpu: string;
  gpusPerInstance: number;
  vcpus?: number;
  memoryGb?: number;
  fabric?: string;
  availability: OfferingAvailability[];
}

export interface AzureSyncResult {
  offerings: AzureOffering[];
  regions: Map<string, AzureRegion>;
}

// Curated: VM SKU -> GPU. Extend this (and add the canonical gpus/ entry) to
// cover more Azure GPU families (NC A100 PCIe, H100 NVL, A100 40GB, etc.).
const INSTANCES: AzureInstance[] = [
  {
    armSkuName: "Standard_ND96isr_H100_v5",
    id: "nd96isr-h100-v5",
    instance: "ND96isr H100 v5",
    baseGpu: "nvidia/h100-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1900,
    fabric: "NVLink + Quantum-2 InfiniBand",
  },
  {
    armSkuName: "Standard_ND96isr_H200_v5",
    id: "nd96isr-h200-v5",
    instance: "ND96isr H200 v5",
    baseGpu: "nvidia/h200-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1900,
    fabric: "NVLink + Quantum-2 InfiniBand",
  },
  {
    armSkuName: "Standard_ND96amsr_A100_v4",
    id: "nd96amsr-a100-v4",
    instance: "ND96amsr A100 v4",
    baseGpu: "nvidia/a100-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1900,
    fabric: "NVLink + HDR InfiniBand",
  },
];

// Curated: Azure region code -> normalized slug + display name + area. Regions
// not listed here are skipped (logged by the runner). Slugs are shared across
// providers; the runner creates any regions/<slug> that don't exist yet.
const AZURE_REGIONS: Record<string, AzureRegion> = {
  // North America
  eastus: { slug: "us-east", name: "US East", area: "North America" },
  eastus2: { slug: "us-east", name: "US East", area: "North America" },
  westus: { slug: "us-west", name: "US West", area: "North America" },
  westus2: { slug: "us-west", name: "US West", area: "North America" },
  westus3: { slug: "us-west", name: "US West", area: "North America" },
  westcentralus: { slug: "us-west", name: "US West", area: "North America" },
  centralus: { slug: "us-central", name: "US Central", area: "North America" },
  northcentralus: { slug: "us-central", name: "US Central", area: "North America" },
  southcentralus: { slug: "us-central", name: "US Central", area: "North America" },
  southcentralus2: { slug: "us-central", name: "US Central", area: "North America" },
  canadacentral: { slug: "ca-central", name: "Canada Central", area: "North America" },
  canadaeast: { slug: "ca-central", name: "Canada Central", area: "North America" },
  mexicocentral: { slug: "mx-central", name: "Mexico Central", area: "North America" },
  // Europe
  westeurope: { slug: "eu-west", name: "EU West", area: "Europe" },
  northeurope: { slug: "eu-west", name: "EU West", area: "Europe" },
  francecentral: { slug: "eu-west", name: "EU West", area: "Europe" },
  spaincentral: { slug: "eu-west", name: "EU West", area: "Europe" },
  swedencentral: { slug: "eu-north", name: "EU North", area: "Europe" },
  norwayeast: { slug: "eu-north", name: "EU North", area: "Europe" },
  germanywestcentral: { slug: "eu-central", name: "EU Central", area: "Europe" },
  germanynorth: { slug: "eu-central", name: "EU Central", area: "Europe" },
  polandcentral: { slug: "eu-central", name: "EU Central", area: "Europe" },
  switzerlandnorth: { slug: "eu-central", name: "EU Central", area: "Europe" },
  switzerlandwest: { slug: "eu-central", name: "EU Central", area: "Europe" },
  italynorth: { slug: "eu-central", name: "EU Central", area: "Europe" },
  uksouth: { slug: "uk-south", name: "UK South", area: "Europe" },
  ukwest: { slug: "uk-south", name: "UK South", area: "Europe" },
  // Middle East
  uaenorth: { slug: "me-central", name: "UAE", area: "Middle East" },
  uaecentral: { slug: "me-central", name: "UAE", area: "Middle East" },
  qatarcentral: { slug: "me-central", name: "UAE", area: "Middle East" },
  // Africa
  southafricanorth: { slug: "af-south", name: "Africa South", area: "Africa" },
  southafricawest: { slug: "af-south", name: "Africa South", area: "Africa" },
  // Asia Pacific
  japaneast: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  japanwest: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  koreacentral: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  koreasouth: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  southeastasia: { slug: "ap-southeast", name: "Asia Southeast", area: "Asia Pacific" },
  indonesiacentral: { slug: "ap-southeast", name: "Asia Southeast", area: "Asia Pacific" },
  malaysiawest: { slug: "ap-southeast", name: "Asia Southeast", area: "Asia Pacific" },
  centralindia: { slug: "ap-south", name: "Asia South", area: "Asia Pacific" },
  southindia: { slug: "ap-south", name: "Asia South", area: "Asia Pacific" },
  australiaeast: { slug: "au-east", name: "Australia East", area: "Asia Pacific" },
  australiasoutheast: { slug: "au-east", name: "Australia East", area: "Asia Pacific" },
  // South America
  brazilsouth: { slug: "sa-east", name: "South America East", area: "South America" },
};

const API_BASE = "https://prices.azure.com/api/retail/prices";

interface RetailItem {
  armSkuName: string;
  armRegionName: string;
  skuName: string;
  productName: string;
  retailPrice: number;
  type: string;
}

async function fetchSku(armSkuName: string): Promise<RetailItem[]> {
  const filter = `serviceName eq 'Virtual Machines' and armSkuName eq '${armSkuName}' and priceType eq 'Consumption'`;
  let url: string | undefined =
    `${API_BASE}?$filter=${encodeURIComponent(filter)}`;
  const items: RetailItem[] = [];
  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Azure Retail Prices API returned ${response.status}`);
    }
    const data = (await response.json()) as {
      Items: RetailItem[];
      NextPageLink?: string;
    };
    items.push(...data.Items);
    url = data.NextPageLink;
  }
  return items;
}

/**
 * Collapse the raw price rows for one SKU into per-slug availability, choosing
 * the cheapest Azure region within each slug and its spot price (only when spot
 * is a genuine discount vs on-demand).
 */
function toAvailability(items: RetailItem[]): {
  availability: OfferingAvailability[];
  unmapped: Set<string>;
} {
  // azureRegion -> { onDemand, spot }
  const byRegion = new Map<string, { onDemand?: number; spot?: number }>();
  for (const item of items) {
    if (item.productName.includes("Windows")) continue; // Linux base price only
    const entry = byRegion.get(item.armRegionName) ?? {};
    if (item.skuName.endsWith(" Spot")) entry.spot = item.retailPrice;
    else if (item.skuName.endsWith(" Low Priority")) continue;
    else entry.onDemand = item.retailPrice;
    byRegion.set(item.armRegionName, entry);
  }

  // slug -> cheapest { azureRegion, onDemand, spot }
  const bySlug = new Map<
    string,
    { azureRegion: string; onDemand: number; spot?: number }
  >();
  const unmapped = new Set<string>();
  for (const [azureRegion, price] of byRegion) {
    if (price.onDemand === undefined) continue;
    const region = AZURE_REGIONS[azureRegion];
    if (!region) {
      unmapped.add(azureRegion);
      continue;
    }
    const current = bySlug.get(region.slug);
    if (current === undefined || price.onDemand < current.onDemand) {
      bySlug.set(region.slug, {
        azureRegion,
        onDemand: price.onDemand,
        spot: price.spot,
      });
    }
  }

  const availability: OfferingAvailability[] = [...bySlug.entries()]
    .map(([slug, best]) => ({
      region: slug,
      providerRegion: best.azureRegion,
      hourly: round(best.onDemand),
      // Only surface spot when it's an actual discount.
      spotHourly:
        best.spot !== undefined && best.spot < best.onDemand
          ? round(best.spot)
          : undefined,
    }))
    .sort((a, b) => a.region.localeCompare(b.region));

  return { availability, unmapped };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export async function syncAzure(): Promise<AzureSyncResult> {
  const offerings: AzureOffering[] = [];
  const regions = new Map<string, AzureRegion>();
  const allUnmapped = new Set<string>();

  for (const spec of INSTANCES) {
    const items = await fetchSku(spec.armSkuName);
    const { availability, unmapped } = toAvailability(items);
    for (const region of unmapped) allUnmapped.add(region);
    if (availability.length === 0) {
      console.warn(`  ! ${spec.armSkuName}: no priced regions found`);
      continue;
    }
    for (const entry of availability) {
      const region = AZURE_REGIONS[entry.providerRegion];
      if (region) regions.set(region.slug, region);
    }
    offerings.push({
      id: spec.id,
      instance: spec.instance,
      baseGpu: spec.baseGpu,
      gpusPerInstance: spec.gpusPerInstance,
      vcpus: spec.vcpus,
      memoryGb: spec.memoryGb,
      fabric: spec.fabric,
      availability,
    });
  }

  if (allUnmapped.size > 0) {
    console.warn(
      `  ! unmapped Azure regions (skipped): ${[...allUnmapped].sort().join(", ")}`,
    );
  }

  return { offerings, regions };
}
