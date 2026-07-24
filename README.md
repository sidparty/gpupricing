# GPU Prices

An open database of on-demand GPU cloud pricing, specs, and availability. It
tracks canonical GPU specifications, the instances each provider offers, the
hourly price of those instances, and the regions where they're available — then
renders a searchable, sortable site and a JSON API from that data.

The top-level navigation is **GPUs**, **Providers**, and **Regions**.

## API

```bash
curl https://models.dev/api.json      # providers and their GPU offerings + pricing
curl https://models.dev/gpus.json     # provider-agnostic canonical GPU specs
curl https://models.dev/catalog.json  # { gpus, providers, regions } in one payload
```

Provider logos are served as SVGs at `/logos/{provider}.svg`.

## Data model

Data lives in the repo as TOML files, organized into three directories:

| Directory | Purpose |
|---|---|
| `gpus/<manufacturer>/<gpu>.toml` | Canonical, provider-agnostic GPU specs (VRAM, TFLOPS, interconnect, …). |
| `providers/<id>/gpus/<gpu>.toml` | A provider's concrete instance/SKU offering, with per-hour pricing and per-region availability. |
| `regions/<slug>/region.toml` | Normalized geographic regions used to group offerings. |

Every price is **per instance per hour**. The per-GPU price shown throughout the
site is derived at render time as `hourly ÷ gpus_per_instance`.

### Canonical GPU — `gpus/<manufacturer>/<gpu>.toml`

The `id` (e.g. `nvidia/h100-sxm`) comes from the file path; never put `id` in
the file. The manufacturer is the first path segment.

```toml
name = "NVIDIA H100 SXM"
description = "Hopper datacenter GPU in SXM5 form factor."
architecture = "Hopper"
vram_gb = 80                 # per single GPU
memory_type = "HBM3"
memory_bandwidth_gbs = 3350
tdp_watts = 700
interconnect = "NVLink 4"    # GPU-native scale-up link
release_date = "2022-03"
last_updated = "2026-07"

[compute]                    # dense (non-sparse) peak; INT8 in TOPS
tf32 = 494.5
fp16 = 989
bf16 = 989
fp8  = 1979
int8 = 1979
```

### Provider offering — `providers/<id>/gpus/<gpu>.toml`

Offerings inherit canonical GPU specs with `base_gpu` and add the instance shape
and pricing. Omit `cost.hourly` for quote-only ("Contact sales") SKUs.

```toml
base_gpu = "nvidia/h100-sxm"       # inherits the canonical specs above
instance = "HGX H100"
gpus_per_instance = 8
vcpus = 128
memory_gb = 2048
local_storage_gb = 61_440
fabric = "NVLink + Quantum-2 InfiniBand"   # cluster network fabric

[cost]
hourly = 49.24                     # per instance, USD (omit for contact-sales)

[[availability]]                   # one entry per region offered
region = "us"                      # must match a regions/<slug>
provider_region = "US"             # native name for detail views
spot_hourly = 19.71                # optional per-region spot price

[[availability]]
region = "eu"
provider_region = "EU"
spot_hourly = 19.51
```

`base_gpu` merge semantics mirror the classic `base_model` machinery: nested
tables (`[compute]`) are deep-merged, arrays and primitives are replaced by the
offering, and `base_gpu_omit = ["compute.int8"]` deletes inherited dot-paths
after the merge. The resolved provider JSON contains no `base_gpu` field.

### Region — `regions/<slug>/region.toml`

```toml
name = "North America"
location = "United States"
```

## Contributing

1. **Add or reuse a canonical GPU** in `gpus/`. Reference it from the offering
   with `base_gpu` rather than duplicating specs.
2. **Add the provider offering** under `providers/<id>/gpus/`. Every `availability`
   region must resolve to a `regions/<slug>/region.toml`.
3. **Cite your source** — link the provider's pricing page in the PR. Put source
   comments at the very top of the TOML file.
4. **Every new provider needs a logo** at `providers/<id>/logo.svg` (SVG, no fixed
   size, `currentColor` fills/strokes, square viewBox).

Validate before opening a PR:

```bash
bun install
bun validate
```

### Working on the frontend

```bash
bun install
cd packages/web
bun run dev      # http://localhost:3000
bun run build    # static site + JSON API into dist/
```
