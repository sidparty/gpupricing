import path from "path";
import { existsSync } from "node:fs";
import { mergeDeep } from "remeda";
import { z } from "zod";

import { Provider, GpuOffering, GpuMetadata, Region } from "./schema.js";

const BaseGpuOffering = GpuOffering.deepPartial()
  .extend({
    id: z.string(),
    base_gpu: z.string().min(1, "Base GPU cannot be empty"),
    base_gpu_omit: z.array(z.string()).optional(),
  })
  .strict();

export interface Catalog {
  gpus: Record<string, GpuMetadata>;
  regions: Record<string, Region>;
  providers: Record<string, Provider>;
}

export async function generateCatalog(directory: string): Promise<Catalog> {
  const gpus = await generateGpus(path.join(directory, "gpus"));
  const regions = await generateRegions(path.join(directory, "regions"));
  const providers = await generateProviders(
    path.join(directory, "providers"),
    gpus,
    regions,
  );

  return { gpus, regions, providers };
}

export async function generateGpus(directory: string) {
  const result: Record<string, GpuMetadata> = {};
  if (!existsSync(directory)) return result;

  for await (const gpuPath of new Bun.Glob("**/*.toml").scan({
    cwd: directory,
    absolute: true,
    followSymlinks: true,
  })) {
    const gpuID = path
      .relative(directory, gpuPath)
      .split(path.sep)
      .join("/")
      .slice(0, -5);
    const toml = await import(gpuPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = gpuID;

    const gpu = GpuMetadata.safeParse(toml);
    if (!gpu.success) {
      gpu.error.cause = { gpuPath, toml };
      throw gpu.error;
    }
    result[gpuID] = gpu.data;
  }

  return result;
}

export async function generateRegions(directory: string) {
  const result: Record<string, Region> = {};
  if (!existsSync(directory)) return result;

  for await (const regionPath of new Bun.Glob("*/region.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const regionID = path.basename(path.dirname(regionPath));
    const toml = await import(regionPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = regionID;

    const region = Region.safeParse(toml);
    if (!region.success) {
      region.error.cause = { regionPath, toml };
      throw region.error;
    }
    result[regionID] = region.data;
  }

  return result;
}

/**
 * Validate a provider tree against the repo root's `gpus/` and `regions/`.
 * Used by `bun validate`.
 */
export async function generate(directory: string) {
  const root = path.dirname(directory);
  const gpus = await generateGpus(path.join(root, "gpus"));
  const regions = await generateRegions(path.join(root, "regions"));

  return generateProviders(directory, gpus, regions);
}

async function generateProviders(
  directory: string,
  gpus: Record<string, GpuMetadata>,
  regions: Record<string, Region>,
) {
  const result: Record<string, Provider> = {};
  if (!existsSync(directory)) return result;

  for await (const providerPath of new Bun.Glob("*/provider.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const providerID = path.basename(path.dirname(providerPath));
    const toml = await import(providerPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = providerID;
    toml.gpus = {};
    const provider = Provider.safeParse(toml);
    if (!provider.success) {
      provider.error.cause = { providerPath, toml };
      throw provider.error;
    }

    const gpusPath = path.join(directory, providerID, "gpus");
    for await (const offeringPath of new Bun.Glob("**/*.toml").scan({
      cwd: gpusPath,
      absolute: true,
      followSymlinks: true,
    })) {
      const offeringID = path
        .relative(gpusPath, offeringPath)
        .split(path.sep)
        .join("/")
        .slice(0, -5);
      const toml = await import(offeringPath, {
        with: {
          type: "toml",
        },
      }).then((mod) => mod.default);
      toml.id = offeringID;

      let offering: GpuOffering;
      if (toml.base_gpu !== undefined) {
        const base = BaseGpuOffering.safeParse(toml);
        if (!base.success) {
          base.error.cause = { offeringPath, toml };
          throw base.error;
        }

        const merged = mergeBaseGpu(base.data, gpus, offeringPath);
        const parsed = GpuOffering.safeParse(merged);
        if (!parsed.success) {
          parsed.error.cause = { offeringPath, toml: merged };
          throw parsed.error;
        }
        offering = parsed.data;
      } else {
        const parsed = GpuOffering.safeParse(toml);
        if (!parsed.success) {
          parsed.error.cause = { offeringPath, toml };
          throw parsed.error;
        }
        offering = parsed.data;
      }

      validateAvailability(offering, regions, offeringPath);
      provider.data.gpus[offeringID] = offering;
    }

    result[providerID] = provider.data;
  }

  const nameToProviderID = new Map<string, string>();
  for (const provider of Object.values(result)) {
    const nameKey = provider.name.toLowerCase();
    const existingID = nameToProviderID.get(nameKey);
    if (existingID !== undefined) {
      throw new Error(
        `Duplicate provider name "${provider.name}" used by both "${existingID}" and "${provider.id}". Provider names must be unique.`,
        {
          cause: {
            providerIDs: [existingID, provider.id],
            name: provider.name,
          },
        },
      );
    }
    nameToProviderID.set(nameKey, provider.id);
  }

  return result;
}

function validateAvailability(
  offering: GpuOffering,
  regions: Record<string, Region>,
  offeringPath: string,
) {
  // Skip cross-validation when no regions are defined at all (partial trees).
  if (Object.keys(regions).length === 0) return;

  for (const entry of offering.availability) {
    if (regions[entry.region] === undefined) {
      throw new Error(
        `Unknown availability region "${entry.region}" in ${offering.id}. Add regions/${entry.region}/region.toml or fix the slug.`,
        { cause: { offeringPath, region: entry.region } },
      );
    }
  }
}

function mergeBaseGpu(
  offering: z.infer<typeof BaseGpuOffering>,
  gpus: Record<string, GpuMetadata>,
  offeringPath: string,
) {
  const base = gpus[offering.base_gpu];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_gpu: ${offering.base_gpu}`, {
      cause: { offeringPath, toml: offering },
    });
  }

  const { base_gpu: _baseGpu, base_gpu_omit: omit, ...overrides } = offering;
  const merged: Record<string, unknown> = structuredClone(
    mergeDeep(inheritableGpuMetadata(base), overrides),
  );

  applyOmit(merged, omit ?? []);
  return merged;
}

function inheritableGpuMetadata(gpu: GpuMetadata) {
  const { id: _id, links: _links, ...metadata } = gpu;

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function applyOmit(target: Record<string, unknown>, paths: string[]) {
  omitLoop: for (const omit of paths) {
    const parts = omit.split(".");
    const parents: Array<{
      value: Record<string, unknown>;
      key: string;
    }> = [];
    let current = target;

    for (const part of parts.slice(0, -1)) {
      const next = current[part];
      if (
        next === undefined ||
        next === null ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
        continue omitLoop;
      }
      parents.push({ value: current, key: part });
      current = next as Record<string, unknown>;
    }

    const lastPart = parts.at(-1);
    if (lastPart === undefined || !(lastPart in current)) {
      continue;
    }

    delete current[lastPart];

    for (let index = parents.length - 1; index >= 0; index--) {
      const parent = parents[index];
      if (parent === undefined) continue;
      const value = parent.value[parent.key];
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0
      ) {
        break;
      }
      delete parent.value[parent.key];
    }
  }
}
