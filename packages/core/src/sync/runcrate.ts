/**
 * Runcrate GPU price sync.
 *
 * Prices come live from Runcrate's public pricing feed
 * (https://www.runcrate.ai/api/gpu-pricing, no key). The feed lists one entry
 * per GPU type with the starting on-demand price per GPU-hour
 * (`min_price_hr`), how many purchasable options are in stock
 * (`available_options`) and the locations those options sit in. It does not
 * break prices out by location and it does not say which form factor a type
 * is, so two things are curated below and never guessed:
 *
 *  - GPU_MAP: which feed `gpu_type` is which canonical `gpus/` entry.
 *  - RUNCRATE_REGIONS: which feed location string is which `regions/<slug>`.
 *
 * Deliberately excluded:
 *  - Types with `available_options` below 1: the feed keeps the last price of
 *    an out-of-stock type, so listing it would publish a stale price.
 *  - H100 and A100 (80GB and 40GB): the feed does not say SXM or PCIe, and
 *    this repo keeps those as separate canonical GPUs.
 *  - H200 NVL, V100 (16GB and 32GB are separate types), RTX 5090/4090/3090,
 *    RTX 6000 Ada, RTX A6000, A40 and L4: no canonical `gpus/` entry yet. Add
 *    the canonical GPU, then one line to GPU_MAP.
 */

import { z } from "zod";

export interface RuncrateGpuMapping {
  /** Feed `gpu_type`, e.g. "RTXPro6000". */
  feedType: string;
  /** Offering file id under providers/runcrate/gpus/. */
  id: string;
  /** Canonical GPU id under gpus/. */
  baseGpu: string;
}

export interface RuncrateRegion {
  slug: string;
  name: string;
  area: string;
}

export interface RuncrateAvailability {
  region: string;
  providerRegion: string;
}

export interface RuncrateOffering {
  id: string;
  instance: string;
  baseGpu: string;
  gpusPerInstance: number;
  hourly: number;
  availability: RuncrateAvailability[];
}

export interface RuncrateSyncResult {
  offerings: RuncrateOffering[];
  regions: Map<string, RuncrateRegion>;
  /** Feed location strings with no entry in RUNCRATE_REGIONS. */
  unmapped: string[];
  /** Feed types that were not turned into an offering, with the reason. */
  skipped: string[];
}

export const FEED_URL = "https://www.runcrate.ai/api/gpu-pricing";

const GPU_MAP: RuncrateGpuMapping[] = [
  { feedType: "B300", id: "b300", baseGpu: "nvidia/b300" },
  { feedType: "B200", id: "b200", baseGpu: "nvidia/b200" },
  // The feed's H200 is the SXM5 part; the NVL card is its own type, H200_nvl.
  { feedType: "H200", id: "h200-sxm", baseGpu: "nvidia/h200-sxm" },
  { feedType: "L40S", id: "l40s", baseGpu: "nvidia/l40s" },
  { feedType: "L40", id: "l40", baseGpu: "nvidia/l40" },
  {
    feedType: "RTXPro6000",
    id: "rtx-pro-6000-blackwell",
    baseGpu: "nvidia/rtx-pro-6000-blackwell",
  },
  { feedType: "A10", id: "a10", baseGpu: "nvidia/a10" },
];

const US_EAST: RuncrateRegion = {
  slug: "us-east",
  name: "US East",
  area: "North America",
};
const US_CENTRAL: RuncrateRegion = {
  slug: "us-central",
  name: "US Central",
  area: "North America",
};
const US_WEST: RuncrateRegion = {
  slug: "us-west",
  name: "US West",
  area: "North America",
};
const CA_CENTRAL: RuncrateRegion = {
  slug: "ca-central",
  name: "Canada Central",
  area: "North America",
};
const EU_WEST: RuncrateRegion = {
  slug: "eu-west",
  name: "EU West",
  area: "Europe",
};
const EU_NORTH: RuncrateRegion = {
  slug: "eu-north",
  name: "EU North",
  area: "Europe",
};
const EU_CENTRAL: RuncrateRegion = {
  slug: "eu-central",
  name: "EU Central",
  area: "Europe",
};
const UK_SOUTH: RuncrateRegion = {
  slug: "uk-south",
  name: "UK South",
  area: "Europe",
};
const AP_NORTHEAST: RuncrateRegion = {
  slug: "ap-northeast",
  name: "Asia Northeast",
  area: "Asia Pacific",
};

// Feed location string -> normalized slug. Same slug conventions as the Azure
// sync. Unmapped locations are skipped and reported by the runner.
const RUNCRATE_REGIONS = new Map<string, RuncrateRegion>(
  Object.entries({
    // North America
    "Ashburn, VA, United States": US_EAST,
    "Beltsville, MD, United States": US_EAST,
    "Boston, MA, United States": US_EAST,
    "Culpeper, VA, United States": US_EAST,
    "Dulles, VA, United States": US_EAST,
    "New York, NY, United States": US_EAST,
    "Newark, NJ, United States": US_EAST,
    "Raleigh, NC, United States": US_EAST,
    "Virginia, United States": US_EAST,
    "Austin, TX, United States": US_CENTRAL,
    "Casper, WY, United States": US_CENTRAL,
    "Dallas, TX, United States": US_CENTRAL,
    "Denver, CO, United States": US_CENTRAL,
    "Des Moines, IA, United States": US_CENTRAL,
    "Houston, TX, United States": US_CENTRAL,
    "Jackson, MS, United States": US_CENTRAL,
    "Kansas City, KS, United States": US_CENTRAL,
    "US Midwest": US_CENTRAL,
    "Wichita, KS, United States": US_CENTRAL,
    "Las Vegas, NV, United States": US_WEST,
    "Los Angeles, CA, United States": US_WEST,
    "Phoenix, AZ, United States": US_WEST,
    "Salt Lake City, UT, United States": US_WEST,
    "San Jose, CA, United States": US_WEST,
    "Calgary, Canada": CA_CENTRAL,
    "Montreal, Canada": CA_CENTRAL,
    "Toronto, Canada": CA_CENTRAL,
    // Europe
    "Dublin, Ireland": EU_WEST,
    "Paris, France": EU_WEST,
    "Saint-Malo, France": EU_WEST,
    "Finland 1": EU_NORTH,
    "Helsinki, Finland": EU_NORTH,
    "Norway 3": EU_NORTH,
    "Oslo, Norway": EU_NORTH,
    "Frankfurt, Germany": EU_CENTRAL,
    "Gdańsk, Poland": EU_CENTRAL,
    Italy: EU_CENTRAL,
    "Warsaw, Poland": EU_CENTRAL,
    "Worcester, United Kingdom": UK_SOUTH,
    // Asia Pacific
    "Japan (fukushima japan 1)": AP_NORTHEAST,
    "Kagawa, Japan": AP_NORTHEAST,
  }),
);

const FeedGpu = z.object({
  gpu_type: z.string(),
  min_price_hr: z.number(),
  available_options: z.number(),
  regions: z.array(z.string()),
});

export const RuncrateFeed = z.object({
  gpus: z.array(FeedGpu),
});

export type RuncrateFeed = z.infer<typeof RuncrateFeed>;

/** Turn a parsed feed into offerings. Pure: no I/O. */
export function buildOfferings(feed: RuncrateFeed): RuncrateSyncResult {
  const offerings: RuncrateOffering[] = [];
  const regions = new Map<string, RuncrateRegion>();
  const unmapped = new Set<string>();
  const skipped: string[] = [];
  const byType = new Map(feed.gpus.map((gpu) => [gpu.gpu_type, gpu]));

  for (const mapping of GPU_MAP) {
    const gpu = byType.get(mapping.feedType);
    if (!gpu) {
      skipped.push(`${mapping.feedType}: not in the feed`);
      continue;
    }
    if (gpu.available_options < 1) {
      skipped.push(`${mapping.feedType}: no options in stock`);
      continue;
    }
    if (!(gpu.min_price_hr > 0)) {
      skipped.push(`${mapping.feedType}: no positive price`);
      continue;
    }
    const availability: RuncrateAvailability[] = [];
    for (const location of new Set(gpu.regions)) {
      const region = RUNCRATE_REGIONS.get(location);
      if (!region) {
        unmapped.add(location);
        continue;
      }
      regions.set(region.slug, region);
      availability.push({ region: region.slug, providerRegion: location });
    }
    if (availability.length === 0) {
      skipped.push(`${mapping.feedType}: no mapped location`);
      continue;
    }
    availability.sort(
      (a, b) =>
        a.region.localeCompare(b.region) ||
        a.providerRegion.localeCompare(b.providerRegion),
    );
    offerings.push({
      id: mapping.id,
      instance: `1x ${gpu.gpu_type}`,
      baseGpu: mapping.baseGpu,
      gpusPerInstance: 1,
      hourly: Math.round(gpu.min_price_hr * 10000) / 10000,
      availability,
    });
  }

  return { offerings, regions, unmapped: [...unmapped].sort(), skipped };
}

export async function syncRuncrate(): Promise<RuncrateSyncResult> {
  const response = await fetch(FEED_URL);
  if (!response.ok) {
    throw new Error(`Runcrate pricing feed returned ${response.status}`);
  }
  const feed = RuncrateFeed.safeParse(await response.json());
  if (!feed.success) {
    throw new Error("Runcrate pricing feed returned an unexpected shape", {
      cause: { url: FEED_URL, error: feed.error },
    });
  }
  return buildOfferings(feed.data);
}
