/**
 * Azure GPU price sync.
 *
 * Prices come live from the public Azure Retail Prices API
 * (https://prices.azure.com/api/retail/prices — no auth). That API does NOT
 * publish GPU count, vCPU or RAM, so those come from the curated INSTANCES
 * table below, sourced from Microsoft Learn VM-size docs. Never invent them:
 * a wrong gpus_per_instance silently corrupts every $/GPU/hr on the site.
 *
 * Azure GPU VMs are all "N-series", so `startswith(armSkuName,'Standard_N')`
 * is the GPU filter (the Retail Prices API has no category field).
 *
 * Every Azure region an offering is sold in is emitted as its own
 * availability entry — several native regions can share one of our slugs
 * (eastus and eastus2 are both us-east) and each keeps its own price.
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
  /** Override the canonical VRAM when the provider ships a different variant. */
  vramGb?: number;
  vcpus?: number;
  memoryGb?: number;
  localStorageGb?: number;
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
  vramGb?: number;
  vcpus?: number;
  memoryGb?: number;
  localStorageGb?: number;
  fabric?: string;
  availability: OfferingAvailability[];
}

export interface AzureSyncResult {
  offerings: AzureOffering[];
  regions: Map<string, AzureRegion>;
}

/**
 * Curated VM SKU -> GPU mapping, from Microsoft Learn size docs.
 *
 * Deliberately excluded:
 *  - `f` / `flex` variants (Standard_ND96isf/isrf/is_flex_H100_v5, the H200 and
 *    GB200 `f` sizes): undocumented by Microsoft, priced identically to their
 *    documented twins — they look like separate capacity pools on the same
 *    hardware, so listing them would just duplicate rows.
 *  - Standard_ND96asr_A100_v4: a re-metered alias of Standard_ND96asr_v4 at an
 *    identical price.
 *  - FPGA (NP) and media-accelerator (NM) sizes: not GPUs.
 *  - RTX PRO 6000 v6 sizes absent from Azure's pricing-calculator feed
 *    (NC8/16/32/64/128/132/256/264/320/324): no published spec to verify GPU
 *    count against.
 *  - NCads A10 v4 (NC8/16/32ads_A10_v4): Microsoft publishes no size page for
 *    this series, so GPU count is unverifiable.
 *
 * Partitioned GPUs are included with a fractional gpusPerInstance (Azure sells
 * 1/6, 1/3 and 1/2 of an A10, and 0.25/0.5 of an RTX PRO 6000).
 */
const INSTANCES: AzureInstance[] = [
  // --- NVIDIA A100 80GB PCIe (NC A100 v4) ---
  {
    armSkuName: "Standard_NC24ads_A100_v4",
    id: "nc24ads-a100-v4",
    instance: "NC24ads A100 v4",
    baseGpu: "nvidia/a100-pcie",
    gpusPerInstance: 1,
    vcpus: 24,
    memoryGb: 220,
    localStorageGb: 958,
  },
  {
    armSkuName: "Standard_NC48ads_A100_v4",
    id: "nc48ads-a100-v4",
    instance: "NC48ads A100 v4",
    baseGpu: "nvidia/a100-pcie",
    gpusPerInstance: 2,
    vcpus: 48,
    memoryGb: 440,
    localStorageGb: 1916,
  },
  {
    armSkuName: "Standard_NC96ads_A100_v4",
    id: "nc96ads-a100-v4",
    instance: "NC96ads A100 v4",
    baseGpu: "nvidia/a100-pcie",
    gpusPerInstance: 4,
    vcpus: 96,
    memoryGb: 880,
    localStorageGb: 3832,
  },
  // --- NVIDIA A100 SXM (ND A100 v4) ---
  {
    armSkuName: "Standard_ND96asr_v4",
    id: "nd96asr-a100-v4",
    instance: "ND96asr A100 v4",
    baseGpu: "nvidia/a100-40gb",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 900,
    localStorageGb: 6000,
    fabric: "NVLink 3 + HDR InfiniBand",
  },
  {
    armSkuName: "Standard_ND96amsr_A100_v4",
    id: "nd96amsr-a100-v4",
    instance: "ND96amsr A100 v4",
    baseGpu: "nvidia/a100-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1900,
    localStorageGb: 6400,
    fabric: "NVLink 3 + HDR InfiniBand",
  },
  {
    armSkuName: "Standard_ND96ams_A100_v4",
    id: "nd96ams-a100-v4",
    instance: "ND96ams A100 v4",
    baseGpu: "nvidia/a100-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1900,
    fabric: "NVLink 3 (no InfiniBand)",
  },
  // --- NVIDIA H100 NVL 94GB (NC ads H100 v5) ---
  {
    armSkuName: "Standard_NC40ads_H100_v5",
    id: "nc40ads-h100-v5",
    instance: "NC40ads H100 v5",
    baseGpu: "nvidia/h100-nvl",
    gpusPerInstance: 1,
    vcpus: 40,
    memoryGb: 320,
    localStorageGb: 3576,
  },
  {
    armSkuName: "Standard_NC80adis_H100_v5",
    id: "nc80adis-h100-v5",
    instance: "NC80adis H100 v5",
    baseGpu: "nvidia/h100-nvl",
    gpusPerInstance: 2,
    vcpus: 80,
    memoryGb: 640,
    localStorageGb: 7152,
  },
  {
    armSkuName: "Standard_NCC40ads_H100_v5",
    id: "ncc40ads-h100-v5",
    instance: "NCC40ads H100 v5 (confidential)",
    baseGpu: "nvidia/h100-nvl",
    gpusPerInstance: 1,
    vcpus: 40,
    memoryGb: 320,
    localStorageGb: 800,
  },
  // --- NVIDIA H100 80GB SXM5 (ND H100 v5) ---
  {
    armSkuName: "Standard_ND96isr_H100_v5",
    id: "nd96isr-h100-v5",
    instance: "ND96isr H100 v5",
    baseGpu: "nvidia/h100-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1900,
    localStorageGb: 28_000,
    fabric: "NVLink 4 + Quantum-2 NDR InfiniBand",
  },
  {
    armSkuName: "Standard_ND96is_H100_v5",
    id: "nd96is-h100-v5",
    instance: "ND96is H100 v5",
    baseGpu: "nvidia/h100-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1900,
    localStorageGb: 28_000,
    fabric: "NVLink 4 (no InfiniBand)",
  },
  // --- NVIDIA H200 ---
  {
    armSkuName: "Standard_ND96isr_H200_v5",
    id: "nd96isr-h200-v5",
    instance: "ND96isr H200 v5",
    baseGpu: "nvidia/h200-sxm",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1850,
    localStorageGb: 28_000,
    fabric: "NVLink 4 + Quantum-2 NDR InfiniBand",
  },
  // --- NVIDIA GB200 (one VM is a 4-GPU slice of the NVL72 rack) ---
  {
    armSkuName: "Standard_ND128isr_NDR_GB200_v6",
    id: "nd128isr-gb200-v6",
    instance: "ND128isr GB200 v6",
    baseGpu: "nvidia/gb200-nvl72",
    gpusPerInstance: 4,
    vramGb: 192,
    vcpus: 128,
    memoryGb: 900,
    localStorageGb: 16_000,
    fabric: "Rack-scale NVLink 5 + Quantum-2 NDR InfiniBand",
  },
  // --- AMD Instinct MI300X ---
  {
    armSkuName: "Standard_ND96isr_MI300X_v5",
    id: "nd96isr-mi300x-v5",
    instance: "ND96isr MI300X v5",
    baseGpu: "amd/mi300x",
    gpusPerInstance: 8,
    vcpus: 96,
    memoryGb: 1850,
    localStorageGb: 28_000,
    fabric: "Infinity Fabric + Quantum-2 NDR InfiniBand",
  },
  // --- NVIDIA T4 (NCasT4 v3) ---
  {
    armSkuName: "Standard_NC4as_T4_v3",
    id: "nc4as-t4-v3",
    instance: "NC4as T4 v3",
    baseGpu: "nvidia/t4",
    gpusPerInstance: 1,
    vcpus: 4,
    memoryGb: 28,
    localStorageGb: 176,
  },
  {
    armSkuName: "Standard_NC8as_T4_v3",
    id: "nc8as-t4-v3",
    instance: "NC8as T4 v3",
    baseGpu: "nvidia/t4",
    gpusPerInstance: 1,
    vcpus: 8,
    memoryGb: 56,
    localStorageGb: 352,
  },
  {
    armSkuName: "Standard_NC16as_T4_v3",
    id: "nc16as-t4-v3",
    instance: "NC16as T4 v3",
    baseGpu: "nvidia/t4",
    gpusPerInstance: 1,
    vcpus: 16,
    memoryGb: 110,
    localStorageGb: 352,
  },
  {
    armSkuName: "Standard_NC64as_T4_v3",
    id: "nc64as-t4-v3",
    instance: "NC64as T4 v3",
    baseGpu: "nvidia/t4",
    gpusPerInstance: 4,
    vcpus: 64,
    memoryGb: 440,
    localStorageGb: 2816,
  },
  // --- NVIDIA A10 (NVads A10 v5) — partitioned and whole GPUs ---
  {
    armSkuName: "Standard_NV6ads_A10_v5",
    id: "nv6ads-a10-v5",
    instance: "NV6ads A10 v5",
    baseGpu: "nvidia/a10",
    gpusPerInstance: 1 / 6,
    vcpus: 6,
    memoryGb: 55,
    localStorageGb: 180,
  },
  {
    armSkuName: "Standard_NV12ads_A10_v5",
    id: "nv12ads-a10-v5",
    instance: "NV12ads A10 v5",
    baseGpu: "nvidia/a10",
    gpusPerInstance: 1 / 3,
    vcpus: 12,
    memoryGb: 110,
    localStorageGb: 360,
  },
  {
    armSkuName: "Standard_NV18ads_A10_v5",
    id: "nv18ads-a10-v5",
    instance: "NV18ads A10 v5",
    baseGpu: "nvidia/a10",
    gpusPerInstance: 0.5,
    vcpus: 18,
    memoryGb: 220,
    localStorageGb: 720,
  },
  {
    armSkuName: "Standard_NV36ads_A10_v5",
    id: "nv36ads-a10-v5",
    instance: "NV36ads A10 v5",
    baseGpu: "nvidia/a10",
    gpusPerInstance: 1,
    vcpus: 36,
    memoryGb: 440,
    localStorageGb: 1440,
  },
  {
    armSkuName: "Standard_NV36adms_A10_v5",
    id: "nv36adms-a10-v5",
    instance: "NV36adms A10 v5",
    baseGpu: "nvidia/a10",
    gpusPerInstance: 1,
    vcpus: 36,
    memoryGb: 880,
    localStorageGb: 2880,
  },
  {
    armSkuName: "Standard_NV72ads_A10_v5",
    id: "nv72ads-a10-v5",
    instance: "NV72ads A10 v5",
    baseGpu: "nvidia/a10",
    gpusPerInstance: 2,
    vcpus: 72,
    memoryGb: 880,
    localStorageGb: 2880,
  },
  // --- NVIDIA RTX PRO 6000 Blackwell SE (NC v6) — partitioned and whole GPUs.
  // Specs from Azure's pricing-calculator feed; Learn has no page for this
  // family yet, so only the sizes that feed publishes are listed. ---
  {
    armSkuName: "Standard_NC24lds_xl_RTXPRO6000BSE_v6",
    id: "nc24lds-rtxpro6000-v6",
    instance: "NC24lds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 0.25,
    vcpus: 24,
    memoryGb: 72,
    localStorageGb: 256,
  },
  {
    armSkuName: "Standard_NC36ds_xl_RTXPRO6000BSE_v6",
    id: "nc36ds-rtxpro6000-v6",
    instance: "NC36ds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 0.25,
    vcpus: 36,
    memoryGb: 132,
    localStorageGb: 256,
  },
  {
    armSkuName: "Standard_NC36lds_xl_RTXPRO6000BSE_v6",
    id: "nc36lds-rtxpro6000-v6",
    instance: "NC36lds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 0.25,
    vcpus: 36,
    memoryGb: 72,
    localStorageGb: 256,
  },
  {
    armSkuName: "Standard_NC72ds_xl_RTXPRO6000BSE_v6",
    id: "nc72ds-rtxpro6000-v6",
    instance: "NC72ds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 0.5,
    vcpus: 72,
    memoryGb: 264,
    localStorageGb: 512,
  },
  {
    armSkuName: "Standard_NC72lds_xl_RTXPRO6000BSE_v6",
    id: "nc72lds-rtxpro6000-v6",
    instance: "NC72lds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 0.5,
    vcpus: 72,
    // The Linux calculator row reports 264 GiB, but every other lds size is
    // half its ds sibling (and the Windows row agrees at 132).
    memoryGb: 132,
    localStorageGb: 512,
  },
  {
    armSkuName: "Standard_NC144ds_xl_RTXPRO6000BSE_v6",
    id: "nc144ds-rtxpro6000-v6",
    instance: "NC144ds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 1,
    vcpus: 144,
    memoryGb: 516,
    localStorageGb: 1024,
  },
  {
    armSkuName: "Standard_NC144lds_xl_RTXPRO6000BSE_v6",
    id: "nc144lds-rtxpro6000-v6",
    instance: "NC144lds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 1,
    vcpus: 144,
    memoryGb: 264,
    localStorageGb: 1024,
  },
  {
    armSkuName: "Standard_NC288ds_xl_RTXPRO6000BSE_v6",
    id: "nc288ds-rtxpro6000-v6",
    instance: "NC288ds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 2,
    vcpus: 288,
    memoryGb: 1032,
    localStorageGb: 2048,
  },
  {
    armSkuName: "Standard_NC288lds_xl_RTXPRO6000BSE_v6",
    id: "nc288lds-rtxpro6000-v6",
    instance: "NC288lds xl RTX PRO 6000 v6",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
    gpusPerInstance: 2,
    vcpus: 288,
    memoryGb: 516,
    localStorageGb: 2048,
  },
];

// Azure region code -> normalized slug + display name + area. Unmapped regions
// are skipped and reported by the runner. Several codes intentionally share a
// slug; each still gets its own availability entry and price.
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
  israelcentral: { slug: "me-west", name: "Middle East West", area: "Middle East" },
  // Africa
  southafricanorth: { slug: "af-south", name: "Africa South", area: "Africa" },
  southafricawest: { slug: "af-south", name: "Africa South", area: "Africa" },
  // Asia Pacific
  japaneast: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  japanwest: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  koreacentral: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  koreasouth: { slug: "ap-northeast", name: "Asia Northeast", area: "Asia Pacific" },
  eastasia: { slug: "ap-east", name: "Asia East", area: "Asia Pacific" },
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
}

async function fetchSku(armSkuName: string): Promise<RetailItem[]> {
  const filter = `serviceName eq 'Virtual Machines' and armSkuName eq '${armSkuName}' and priceType eq 'Consumption'`;
  let url: string | undefined =
    `${API_BASE}?$filter=${encodeURIComponent(filter)}`;
  const items: RetailItem[] = [];
  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Azure Retail Prices API returned ${response.status} for ${armSkuName}`,
      );
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
 * Collapse raw price rows into one availability entry per Azure region.
 * Linux on-demand only; Windows rows carry a licence premium, and Spot /
 * Low Priority rows are folded in as the region's spot price.
 */
function toAvailability(items: RetailItem[]): {
  availability: OfferingAvailability[];
  unmapped: Set<string>;
} {
  const byRegion = new Map<string, { onDemand?: number; spot?: number }>();
  for (const item of items) {
    if (item.productName.includes("Windows")) continue;
    const entry = byRegion.get(item.armRegionName) ?? {};
    if (item.skuName.endsWith(" Spot")) entry.spot = item.retailPrice;
    else if (item.skuName.endsWith(" Low Priority")) continue;
    else entry.onDemand = item.retailPrice;
    byRegion.set(item.armRegionName, entry);
  }

  const availability: OfferingAvailability[] = [];
  const unmapped = new Set<string>();
  for (const [azureRegion, price] of byRegion) {
    if (price.onDemand === undefined) continue;
    const region = AZURE_REGIONS[azureRegion];
    if (!region) {
      unmapped.add(azureRegion);
      continue;
    }
    availability.push({
      region: region.slug,
      providerRegion: azureRegion,
      hourly: round(price.onDemand),
      // Only surface spot when it's an actual discount.
      spotHourly:
        price.spot !== undefined && price.spot < price.onDemand
          ? round(price.spot)
          : undefined,
    });
  }

  availability.sort(
    (a, b) =>
      a.region.localeCompare(b.region) ||
      a.providerRegion.localeCompare(b.providerRegion),
  );
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
      console.warn(`  ! ${spec.armSkuName}: no priced regions found — skipped`);
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
      vramGb: spec.vramGb,
      vcpus: spec.vcpus,
      memoryGb: spec.memoryGb,
      localStorageGb: spec.localStorageGb,
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
