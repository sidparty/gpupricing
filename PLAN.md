# Plan: Models.dev → GPU Pricing Database

Convert this repo from an LLM model/pricing database into a GPU pricing database.
The top-level navigation switches from **Models / Providers / Labs** to
**GPUs / Providers / Regions**.

## Architecture mapping

The existing three-way structure maps cleanly onto GPUs:

| Current | New | Role |
|---|---|---|
| `models/<lab>/<model>.toml` | `gpus/<maker>/<gpu>.toml` | Canonical GPU specs (maker-agnostic) |
| `providers/<id>/models/*.toml` | `providers/<id>/gpus/*.toml` | Per-provider GPU offerings + pricing |
| `labs/<id>/lab.toml` | *dropped* — makers are just a field | Simpler than labs |
| Nav: Models / Providers / Labs | **GPUs / Providers / Regions** | Regions become a derived index |

## Phase 1 — Data layer (`packages/core`)

New schemas in `schema.ts` (keeping the same Zod strict patterns):

```ts
// Canonical GPU metadata — gpus/nvidia/h100.toml
GpuMetadata = {
  id, name, description?,               // id auto-injected from filename
  maker: "nvidia" | "amd" | "google" | "intel" | ...,
  architecture: string,                 // "Hopper", "Blackwell", "CDNA3"
  vram: number,                         // GB
  memory_bandwidth?: number,            // GB/s
  interconnect?: string,                // "NVLink 4", "Infinity Fabric"
  tdp?: number,                         // watts
  fp16_tflops?, bf16_tflops?, fp8_tflops?, // compute specs
  release_date?, last_updated?,
  links?: Link[],
}

// Provider offering — providers/lambda/gpus/nvidia-h100.toml
GpuOffering = {
  base_gpu: "nvidia/h100",              // reuse the base_model merge machinery
  base_gpu_omit?: string[],
  name?, variant?: string,              // e.g. "H100 SXM", "H100 PCIe", "GH200"
  gpus_per_instance: number,            // pricing unit (1x, 8x configs)
  cost: {
    hourly: number,                     // per-GPU per-hour on-demand
    spot?: number,
    reserved_monthly?: number,          // 1mo/committed pricing
  },
  min_count?: number,
  max_count?: number,
  regions: Region[],                    // see below
  status?: "beta" | "deprecated",
  last_updated: string,
}

Region = {
  id: string,                           // "us-east-1", "us-west", "eu-central"
  name?: string,
  country?: string,                     // enables region grouping/flags
  hourly?: number,                      // overrides offering-level price
  spot?: number,
  available?: boolean,
}
```

New `generateGpuCatalog()` in `generate.ts` — mirror the existing
model/provider pipeline: scan `gpus/`, scan `providers/*/gpus/`, resolve
`base_gpu` inheritance with `mergeDeep` (this machinery already exists and is
directly reusable).

Provider schema change: `env`/`npm`/`api` become optional or
GPU-cloud-appropriate (e.g. `terraform`, console URL). Keep `name`, `doc`,
`logo.svg` requirements.

## Phase 2 — Seed data

- Create `gpus/nvidia/` with ~15 canonical entries: H100, H200, B200, GB200,
  A100-40/80, L40S, L4, A10, RTX 4090/5090/6000, plus `amd/` (MI300X, MI325X)
  and `google/` (TPU v5p/v6e — decide whether TPUs count as "GPUs" or get a
  `type` field).
- Create provider dirs for: `lambda`, `coreweave`, `runpod`, `vast-ai`,
  `nebius`, `crusoe`, `together`, `fireworks`, `aws`, `google-cloud`, `azure`,
  `oci`, `fluidstack`, `datacrunch`. ~5–8 to start, each with `provider.toml`,
  `logo.svg` (currentColor, per AGENTS.md logo rules), and `gpus/*.toml` with
  real hourly pricing + regions.

## Phase 3 — Rendering (`packages/web/src/render.tsx`)

This is the biggest lift. The file is ~1,700 lines and deeply model-shaped;
the plan is a structured rewrite, not a patch:

1. **Entry builders**: `buildGpuEntries()` (canonical GPU → linked provider
   offerings, min hourly price), `buildProviderOfferingEntries()`,
   `buildRegionEntries()` (new: aggregate all offerings by region id →
   providers + GPUs available there).
2. **Pages**:
   - `/` + `/gpus` — GPU table: Name, Maker, VRAM, Architecture, Providers
     (count), Best $/hr, Spot $/hr, FP16 TFLOPS, Updated
   - `/gpus/<maker>/<gpu>` — spec Facts grid (VRAM, bandwidth, TDP,
     interconnect…) + providers table (Provider, Config, $/hr, Spot,
     Min count, Regions)
   - `/providers` — table: Provider, GPUs offered, Min $/hr, Regions count,
     Docs
   - `/providers/<id>` — Facts + offering table (GPU, VRAM, Config, $/hr,
     Spot, Regions)
   - `/regions` — table: Region, Country, Providers, GPUs available, Min $/hr
   - `/regions/<id>` — region detail: which providers/GPUs are available
     there and at what price
3. **Nav**: `ActiveSection` → `"gpus" | "providers" | "regions"`; update
   `Header`, `MobileMenu`, search dialog placeholder.
4. **Search index**: `type: "gpu" | "provider" | "region"` with tokens for
   VRAM, maker, price, region names.
5. **Metadata helpers**: rewrite `gpuPageMetadata`/`regionPageMetadata`
   (e.g. "H100 pricing from $1.99/hr across 12 providers").

## Phase 4 — Server, assets, client JS

- `server.ts`: add `/gpus.json` endpoint, rename `/catalog.json` payload;
  region logo route not needed (country flags can be inline emoji/CSS).
- `index.ts` (client, 763 lines): mostly generic table-sort/search/copy
  logic — should survive largely intact; only audit for model-specific
  strings.
- `shared.ts`: add `formatHourlyCost()` (`$1.99/hr`), drop token-cost
  formatters.
- `index.css`: likely reusable as-is; check for model-specific classes.
- Help dialog copy, `index.html` title/meta, favicon, social-share image.

## Phase 5 — Repo hygiene

- Delete or archive `models/`, `labs/`, `models.json`, and all LLM provider
  dirs.
- Update `AGENTS.md` (schema docs, contribution checklist, logo rules still
  apply), `README.md`.
- Decide on sync modules later — some clouds (RunPod, Vast.ai) have pricing
  APIs suitable for the existing `sync/` pattern.

## Suggested build order

1. Schemas + `generateGpuCatalog` + 2 makers / 3 providers of seed data →
   `bun validate` green
2. Render rewrite for the 6 page types + nav
3. Search index + client JS audit
4. Server endpoints + help dialog + meta
5. Fill out remaining seed data, cleanup, README/AGENTS.md

## Open questions

1. **Scope of "GPU"** — include TPUs / Trainium / Groq LPUs, or strictly GPUs?
   (Default: add a `type` field so it's extensible, seed with GPUs only.)
2. **Pricing granularity** — per-GPU-hour only, or also full-instance configs
   (8x H100 nodes)? (Default: `gpus_per_instance` field handles both.)
3. **Keep the old LLM data** in a branch/archive, or hard-delete from this
   repo?
4. **Brand name** for the header (currently "Models.dev") — e.g. "GPUs.dev"?
   (Default: placeholder "GPU Pricing".)
