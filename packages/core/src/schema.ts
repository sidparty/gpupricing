import { z } from "zod";

const DateString = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, {
  message: "Must be in YYYY-MM or YYYY-MM-DD format",
});

const UrlString = z.string().url("Must be a valid URL");

/**
 * Dense (non-sparse) peak compute throughput.
 * FP/BF/TF values are TFLOPS; INT8 is TOPS. All optional — most catalogs only
 * publish a subset. Values are per single GPU.
 */
const Compute = z
  .object({
    fp64: z.number().min(0, "FP64 throughput cannot be negative").optional(),
    tf32: z.number().min(0, "TF32 throughput cannot be negative").optional(),
    fp16: z.number().min(0, "FP16 throughput cannot be negative").optional(),
    bf16: z.number().min(0, "BF16 throughput cannot be negative").optional(),
    fp8: z.number().min(0, "FP8 throughput cannot be negative").optional(),
    fp4: z.number().min(0, "FP4 throughput cannot be negative").optional(),
    int8: z.number().min(0, "INT8 throughput cannot be negative").optional(),
  })
  .strict();

export const GpuLink = z
  .object({
    label: z.string().min(1, "Link label cannot be empty").optional(),
    url: UrlString,
    type: z
      .enum(["datasheet", "product", "docs", "announcement", "spec", "other"])
      .optional(),
  })
  .strict();

/**
 * Canonical, provider-agnostic GPU facts. Lives at
 * `gpus/<manufacturer>/<gpu>.toml`; the `id` (e.g. `nvidia/h100-sxm`) is
 * injected from the file path. Manufacturer is derived from the id prefix.
 */
const GpuMetadataBase = z.object({
  id: z.string(),
  name: z.string().min(1, "GPU name cannot be empty"),
  description: z.string().min(1, "GPU description cannot be empty").optional(),
  architecture: z.string().min(1, "Architecture cannot be empty").optional(),
  vram_gb: z.number().min(0, "VRAM cannot be negative"),
  memory_type: z.string().min(1, "Memory type cannot be empty").optional(),
  memory_bandwidth_gbs: z
    .number()
    .min(0, "Memory bandwidth cannot be negative")
    .optional(),
  tdp_watts: z.number().min(0, "TDP cannot be negative").optional(),
  // GPU-native scale-up interconnect, e.g. "NVLink 4", "NVLink 5", "PCIe 5.0".
  interconnect: z.string().min(1, "Interconnect cannot be empty").optional(),
  compute: Compute.optional(),
  release_date: DateString.optional(),
  last_updated: DateString.optional(),
  links: z.array(GpuLink).optional(),
});

export const GpuMetadata = GpuMetadataBase.strict();

export type GpuMetadata = z.infer<typeof GpuMetadata>;

/** Per-instance hourly pricing (USD). `hourly` is omitted for quote-only SKUs. */
const Cost = z
  .object({
    hourly: z.number().min(0, "Hourly price cannot be negative").optional(),
    spot_hourly: z
      .number()
      .min(0, "Spot hourly price cannot be negative")
      .optional(),
  })
  .strict();

/**
 * One region an offering is available in. `region` is a normalized slug that
 * must resolve to a `regions/<slug>/region.toml`. `provider_region` is the
 * cloud's native name (e.g. `us-east-1`). Prices override the offering-level
 * `[cost]` for that region.
 */
const Availability = z
  .object({
    region: z.string().min(1, "Availability region cannot be empty"),
    provider_region: z
      .string()
      .min(1, "Provider region cannot be empty")
      .optional(),
    hourly: z.number().min(0, "Hourly price cannot be negative").optional(),
    spot_hourly: z
      .number()
      .min(0, "Spot hourly price cannot be negative")
      .optional(),
  })
  .strict();

/**
 * A provider's concrete GPU offering — the canonical GPU spec (inherited via
 * `base_gpu`) plus the instance/SKU shape and pricing. Lives at
 * `providers/<id>/gpus/<gpu>.toml`.
 */
export const GpuOffering = z
  .object({
    id: z.string(),
    // GPU spec — inherited from `base_gpu` or authored inline.
    name: z.string().min(1, "GPU name cannot be empty"),
    description: z
      .string()
      .min(1, "GPU description cannot be empty")
      .optional(),
    architecture: z.string().min(1, "Architecture cannot be empty").optional(),
    vram_gb: z.number().min(0, "VRAM cannot be negative"),
    memory_type: z.string().min(1, "Memory type cannot be empty").optional(),
    memory_bandwidth_gbs: z
      .number()
      .min(0, "Memory bandwidth cannot be negative")
      .optional(),
    tdp_watts: z.number().min(0, "TDP cannot be negative").optional(),
    interconnect: z.string().min(1, "Interconnect cannot be empty").optional(),
    compute: Compute.optional(),
    release_date: DateString.optional(),
    last_updated: DateString.optional(),
    links: z.array(GpuLink).optional(),
    // Offering-specific instance shape.
    instance: z.string().min(1, "Instance name cannot be empty"),
    gpus_per_instance: z
      .number()
      .int("GPUs per instance must be an integer")
      .min(1, "An instance must have at least one GPU"),
    vcpus: z.number().min(0, "vCPUs cannot be negative").optional(),
    memory_gb: z.number().min(0, "System memory cannot be negative").optional(),
    local_storage_gb: z
      .number()
      .min(0, "Local storage cannot be negative")
      .optional(),
    // Cluster/network fabric, e.g. "InfiniBand", "Ethernet", "NVLink".
    fabric: z.string().min(1, "Fabric cannot be empty").optional(),
    cost: Cost.optional(),
    availability: z
      .array(Availability)
      .min(1, "An offering must be available in at least one region"),
  })
  .strict();

export type GpuOffering = z.infer<typeof GpuOffering>;

export const Region = z
  .object({
    id: z.string(),
    name: z.string().min(1, "Region name cannot be empty"),
    location: z.string().min(1, "Region location cannot be empty").optional(),
    // Top-level grouping bucket for the regions view, e.g. "North America", "Europe".
    area: z.string().min(1, "Region area cannot be empty").optional(),
  })
  .strict();

export type Region = z.infer<typeof Region>;

export const Provider = z
  .object({
    id: z.string(),
    name: z.string().min(1, "Provider name cannot be empty"),
    doc: UrlString,
    type: z.enum(["cloud", "neocloud", "marketplace"]),
    api: UrlString.optional(),
    gpus: z.record(GpuOffering),
  })
  .strict();

export type Provider = z.infer<typeof Provider>;
