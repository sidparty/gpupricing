# Agent Guidelines

## Commands
- **Validate**: `bun validate` — validates all GPU / offering / region / provider TOML and cross-references.
- **Build web**: `cd packages/web && bun run build` — builds the static site + JSON API into `dist/`.
- **Dev server**: `cd packages/web && bun run dev` — runs the dev server at http://localhost:3000.
- **Sync Azure prices**: `bun run azure:sync` — regenerates `providers/azure/` from the live Azure Retail Prices API, then run `bun validate`.

## Automated price sync

Providers with a public pricing API are populated by a sync module rather than
hand-authored. **Azure is the reference implementation:**

- Logic lives in `packages/core/src/sync/azure.ts` (fetches the no-auth Azure
  Retail Prices API and normalizes it); the runner
  `packages/core/script/sync-azure.ts` regenerates `providers/azure/gpus/*.toml`
  (marked `# AUTO-SYNCED` — never hand-edit), creates any missing
  `regions/<slug>`, and leaves `provider.toml`/`logo.svg` alone once created.
- Two curated tables keep it honest: an **instance→GPU map** (which VM SKU is
  which GPU, and how many — sourced from Microsoft Learn VM-size docs) and an
  **Azure-region→slug map**. Prices always come live from the API; extend the
  maps to add SKUs/regions. The API does **not** publish GPU count, vCPU or RAM
  — never invent them, since a wrong `gpus_per_instance` corrupts every
  `$/GPU/hr` on the site.
- All Azure GPU VMs are N-series, so `startswith(armSkuName,'Standard_N')` acts
  as the GPU filter (the API has no category field).
- **Every** Azure region an offering sells in gets its own `[[availability]]`
  entry with the native code in `provider_region`. Several native regions can
  share one slug (`eastus` and `eastus2` are both `us-east`) and each keeps its
  own price — do not collapse them, or regions silently disappear from the site.
- Deliberately excluded: undocumented `f`/`flex` capacity-pool variants that
  duplicate a documented SKU at an identical price, re-metered aliases, and
  non-GPU N-series (FPGA `NP`, media-accelerator `NM`) sizes.

## Code Style
- **Runtime**: Bun with TypeScript ESM modules.
- **Imports**: use `.js` extensions for local imports (e.g. `./schema.js`).
- **Types**: Zod schemas for validation, `z.infer<typeof Schema>` for inferred types.
- **Error handling**: `safeParse()` with a structured `error.cause` (`{ path, toml }`).
- **File ops**: Bun native APIs (`Bun.Glob`, `Bun.file`, `Bun.write`).

## Architecture
- **Monorepo**: `packages/core` (schema + generation), `packages/web` (static site + dev server), `packages/function` (Cloudflare worker).
- **Data**: TOML files in `gpus/`, `providers/`, and `regions/`.
- **Validation**: `generateCatalog()` in `packages/core` parses and cross-validates everything.

## Data model

Three layers. IDs are always injected from the file path — never put `id` in a TOML file.

### Canonical GPUs — `gpus/<manufacturer>/<gpu>.toml`
Provider-agnostic facts about a GPU. `id` = path (e.g. `nvidia/h100-sxm`);
manufacturer = first path segment.

- Required: `name`, `vram_gb` (per single GPU).
- Optional: `description`, `architecture`, `memory_type`, `memory_bandwidth_gbs`,
  `tdp_watts`, `interconnect` (GPU-native scale-up link, e.g. `NVLink 4`),
  `release_date`, `last_updated`, `links`, and `[compute]`.
- `[compute]` holds **dense (non-sparse)** peak throughput: `fp64`, `tf32`, `fp16`,
  `bf16`, `fp8`, `fp4` in TFLOPS and `int8` in TOPS. Do not use with-sparsity
  figures (they are 2× the dense values).

### Provider offerings — `providers/<id>/gpus/<gpu>.toml`
A concrete instance/SKU with pricing.

- Required: `instance`, `gpus_per_instance` (integer ≥ 1), `availability[]`
  (at least one), and the GPU spec fields — supplied via `base_gpu` inheritance
  or inline.
- Optional: `vcpus`, `memory_gb` (system RAM), `local_storage_gb`, `fabric`
  (cluster network fabric, e.g. `InfiniBand`, `Ethernet`), `[cost]`.
- `[cost].hourly` prices the **whole instance** per hour (USD). Omit it for
  quote-only "Contact sales" SKUs. `[cost].spot_hourly` is optional.
- Each `[[availability]]` entry: `region` (must resolve to `regions/<slug>`),
  optional `provider_region` (native name), and optional per-region `hourly` /
  `spot_hourly` overrides.

**Pricing rules:**
- Per-GPU price = `hourly ÷ gpus_per_instance`, computed at render time, never stored.
- Effective regional price = `availability` override `??` the `[cost]` default.

### `base_gpu` inheritance
```toml
base_gpu = "nvidia/h100-sxm"
base_gpu_omit = ["compute.int8"]  # optional, dot-path strings
```
- `base_gpu` must point to an existing `gpus/` entry.
- Merge: nested tables (`[compute]`) are deep-merged; arrays and primitives are
  replaced by the offering; omitted fields are inherited verbatim.
- `base_gpu_omit` runs after the merge and deletes each dot-path; ancestor tables
  that become empty are pruned.
- The resolved provider JSON contains no `base_gpu` / `base_gpu_omit`.

### Regions — `regions/<slug>/region.toml`
- Required: `name`, `location`. `id` = directory name.
- Every offering `availability.region` must match a region slug, or validation fails.

### Providers — `providers/<id>/provider.toml`
- Required: `name`, `doc` (URL), `type` (`cloud` | `neocloud` | `marketplace`).
- Optional: `api` (URL). `gpus` is populated during generation — do not author it.

## Contribution Review Checklist

### New providers (blocker)
- **Must ship a logo** at `providers/<id>/logo.svg` — SVG, no fixed size or colors
  (use `currentColor`), prefer a square `viewBox` (e.g. `0 0 24 24`).

### New offerings
- **Use `base_gpu`** when a `gpus/` entry exists for the underlying GPU; only write
  a full inline spec when none exists.
- **Per-instance pricing**: `cost.hourly` is the whole-instance price, not per GPU.
- **Every availability region** must exist in `regions/`.

### Citations (recommended)
- **Cite sources** — link the provider's pricing page in the PR body.
- **In-file comments belong at the top of the file**, above the first key.
