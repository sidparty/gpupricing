# Plan: Models.dev → GPU Pricing Database

Convert this repo from an LLM model/pricing database into a GPU pricing
database. The top-level navigation switches from **Models / Providers / Labs**
to **GPUs / Providers / Regions**.

This version supersedes the earlier draft with finalized data-model decisions:

1. **Regions — both normalized and native.** Offerings map to canonical
   geo-region slugs (`us-east`, `eu-west`, …) for grouping, *and* record the
   provider's native region name (`us-east-1`, `us-east4`) for display in
   detail views.
2. **Pricing — per-instance hourly.** `cost.hourly` prices the whole
   instance/SKU; `gpus_per_instance` enables derived per-GPU comparisons at
   render time.
3. **Catalog scope — datacenter + prosumer.** Datacenter accelerators plus
   high-end consumer cards commonly rented (RTX 4090/5090, A6000).

## Architecture mapping

The existing three-layer design translates almost 1:1:

| Current (AI models) | New (GPU pricing) |
|---|---|
| `models/<lab>/<model>.toml` — canonical model facts | `gpus/<manufacturer>/<gpu>.toml` — canonical GPU specs |
| `providers/<id>/provider.toml` + `models/*.toml` — hosts with token pricing | `providers/<id>/provider.toml` + `gpus/*.toml` — clouds with $/hr pricing |
| `labs/` — derived from `models/` prefix | `regions/` — **new explicit directory**, aggregated from offering data |
| `base_model` inheritance | `base_gpu` inheritance (same merge machinery, renamed) |
| `cost.input/output` per 1M tokens | `cost.hourly` (+ `spot_hourly`) per instance |
| `limit.context/output`, `modalities`, `reasoning_options` | `vram_gb`, `[compute]` TFLOPS, `gpus_per_instance`, `availability[]` |

The generic machinery survives untouched: TOML→Zod ingestion, the `base_model`
deep-merge, sortable/searchable table components (`TableSection`, `SortableTh`,
`data-sort`/`data-search`), the search dialog shell, static-site build, and the
Cloudflare worker.

The one structural difference: **labs were derived from directory prefixes;
regions are aggregated from offering data** (each offering declares where it's
available). That aggregation is the main new code.

## Data model

### Canonical GPUs — `gpus/<manufacturer>/<gpu>.toml` (replaces `models/`)

```toml
# gpus/nvidia/h100-sxm.toml
name = "NVIDIA H100 SXM"
description = "Hopper datacenter GPU, SXM5 form factor"
architecture = "Hopper"
vram_gb = 80
memory_type = "HBM3"          # HBM3 | HBM3e | HBM2e | GDDR6X | GDDR7
tdp_watts = 700
interconnect = "NVLink 4"     # optional
release_date = "2023-03"
last_updated = "2026-07"

[compute]                     # dense TFLOPS
fp16 = 989
bf16 = 989
fp8  = 1979
int8 = 1979
```

### Provider offerings — `providers/<id>/gpus/<gpu>.toml`

```toml
# providers/aws/gpus/h100-sxm.toml
base_gpu = "nvidia/h100-sxm"        # inherits specs via existing merge machinery
instance = "p5.48xlarge"
gpus_per_instance = 8

[cost]
hourly = 98.32                      # per instance, USD (required)
spot_hourly = 31.20                 # optional

# One entry per region where offered:
#   region          = normalized slug for grouping (must exist in regions/)
#   provider_region = native name, shown in detail views
#   hourly/spot     = optional per-region price overrides
[[availability]]
region = "us-east"
provider_region = "us-east-1"

[[availability]]
region = "us-west"
provider_region = "us-west-2"
hourly = 100.20
```

```toml
# providers/runpod/gpus/rtx-4090.toml  (prosumer, 1x instance)
base_gpu = "nvidia/rtx-4090"
instance = "1x RTX 4090"
gpus_per_instance = 1

[cost]
hourly = 0.44
spot_hourly = 0.19

[[availability]]
region = "us-east"
provider_region = "US-KS-2"
```

### Regions — `regions/<slug>/region.toml` (new; the 3rd nav section)

```toml
# regions/us-east/region.toml
name = "US East"
location = "N. America — Virginia / New York / Montreal"
```

### Provider definition (simplified)

```toml
# providers/runpod/provider.toml
name = "RunPod"
doc = "https://docs.runpod.io"
api = "https://api.runpod.io/graphql"   # optional
type = "neocloud"                        # cloud | neocloud | marketplace
```

Drops `env`/`npm` (AI-SDK-specific). Logo still required at
`providers/<id>/logo.svg` (SVG, `currentColor`, square viewBox).

---

## Phase 1 — Core (`packages/core`)

- **`schema.ts`**: new `GpuMetadata`, `GpuOffering` (`base_gpu`, `instance`,
  `gpus_per_instance` ≥ 1, `Cost { hourly, spot_hourly? }`, `availability[]`
  with refine: `region` slug must exist in `regions/`), simplified `Provider`.
  Delete `Modalities`, `Limit`, `ReasoningOption`, `BenchmarkResult`, weights.
- **`generate.ts`**: `generateGpus()` (replaces `generateModels`),
  `generateProviders()` keeps the `base_model`→`base_gpu` merge + omit logic
  untouched, new `generateRegions()` + cross-validation of availability slugs.
- **Delete** `family.ts` (hardcoded AI families), `describe.ts` (AI
  description generator).
- `bun validate` passes on the seeded data.

## Phase 2 — Seed data

- Delete `models/`, `labs/`, root `models.json` (unused OpenRouter snapshot),
  all old provider TOMLs.
- `gpus/`: ~15 entries — `nvidia/` (b200, h200, h100-sxm, h100-pcie,
  a100-80gb, a100-40gb, l40s, l4, rtx-4090, rtx-5090, rtx-a6000), `amd/`
  (mi300x, mi325x), `intel/` (gaudi-3).
- `providers/`: ~8–10 — aws, gcp, azure, lambda, coreweave, runpod, vast-ai,
  nebius (+ fluidstack/oci if data permits). Each: `provider.toml`, compliant
  `logo.svg`, 2–6 offerings with real published prices.
- `regions/`: ~11 slugs (us-east, us-west, us-central, ca-central, eu-west,
  eu-central, eu-north, ap-southeast, ap-northeast, ap-south, sa-east).

## Phase 3 — Web (`packages/web`)

**`render.tsx`** (bulk of the work):

- `ActiveSection` → `"gpus" | "providers" | "regions"`; update `Header`,
  `MobileMenu`, brand/tagline.
- `buildPages()`: `/`+`/gpus` (home), `/providers`, `/regions`; details
  `/gpus/<mfr>/<gpu>`, `/providers/<id>`, `/regions/<slug>`.
- Entry builders:
  - `buildGpuEntries` — canonical GPU + rollups: provider count, region count,
    **min $/hr per GPU** = min over offerings of `hourly / gpus_per_instance`.
  - `buildOfferingEntries` — flattened provider offerings; resolve regional
    overrides into effective prices.
  - `buildRegionEntries` — **new**: group offerings by slug → provider count,
    GPU count, min per-GPU $/hr.
- Tables (reusing generic `TableSection`/`SortableTh`/`data-sort` machinery):
  - **GpuTable**: GPU · Manufacturer · VRAM · FP16 TFLOPS · Providers ·
    Regions · Best $/GPU/hr · Updated
  - **OfferingTable**: Provider · Instance · GPUs · VRAM total ·
    $/instance/hr · $/GPU/hr (derived) · Spot $/GPU/hr · Regions (native names
    in detail views)
  - **ProvidersPage**: Provider · Type · GPU models · Regions · Min $/GPU/hr ·
    Docs
  - **RegionsPage**: Region · Location · Providers · GPUs · Min H100 $/GPU/hr
    · Min RTX 4090 $/GPU/hr
- Search items → gpu/provider/region kinds with new meta chips; `shared.ts`
  formatters → `formatHourly`, `formatVram`, `formatTflops`; metadata
  builders, `HelpDialog`, tagline rebrand.

**`index.ts`**: sorting/copy/dialog logic is generic and untouched; only
`SearchIndexItem` + `resultMeta()` get GPU fields.

**`index.html`**: title/description.

## Phase 4 — Build & deploy

- `script/build.ts`: drop labs logo copying; keep provider logos (manufacturer
  stays a text column initially).
- `worker.ts`: `isHtmlRoute()` → `/gpus`, `/providers`, `/regions`; JSON
  endpoints `gpus.json` / `api.json` / `catalog.json` from new core output.
- `sst.config.ts`: unchanged.

## Phase 5 — Docs & cleanup

- Rewrite `AGENTS.md` (GPU/offering/region TOML conventions, `base_gpu`
  semantics, per-instance pricing rule, region slug rules, logo requirement)
  and `README.md`.
- Remove `sync.md` + the obsolete `audit-reasoning-options` skill; note that
  RunPod/Vast.ai/Lambda expose public pricing APIs suitable for future sync
  modules.

## Key derivations to get right

1. **$/GPU/hr = hourly ÷ gpus_per_instance** — used for all cross-provider
   sorting/comparison; computed at render time, never stored.
2. **Effective regional price** = availability override ?? `[cost]` default —
   resolved once in `buildOfferingEntries`.
3. **Region aggregation** is the one genuinely new mechanism (labs were
   prefix-derived; regions are offering-derived).

## Suggested build order

1. Schemas + `generateGpus`/`generateRegions` + 2 manufacturers / 3 providers
   of seed data → `bun validate` green
2. Render rewrite for the 6 page types + nav
3. Search index + client JS audit
4. Server/worker endpoints + help dialog + meta
5. Fill out remaining seed data, cleanup, README/AGENTS.md
