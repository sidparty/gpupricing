# Agent Guidelines

## Commands
- **Validate**: `bun validate` — validates all GPU / offering / region / provider TOML and cross-references.
- **Build web**: `cd packages/web && bun run build` — builds the static site + JSON API into `dist/`.
- **Dev server**: `cd packages/web && bun run dev` — runs the dev server at http://localhost:3000.
- **Sync Azure prices**: `bun run azure:sync` — regenerates `providers/azure/` from the live Azure Retail Prices API, then run `bun validate`.
- **Lint**: `bun run lint` — oxlint with the repo's custom `anti-slop` JS plugin
  (`tools/oxlint/anti-slop/`). The plugin is TypeScript and oxlint runs it via
  `node`, so Node >= 22.18 must be on PATH (CI pins Node 22).
- **Test**: `bun test` (single file: `bun test path/to/file.test.ts`). No test
  files exist yet; `bun validate` and the web build are the real checks.
- `bun validate` prints the whole resolved catalog as JSON on success; on a
  `ZodError` it prints the errors plus `cause` (`{ path, toml }`) and exits 1.
- `bun run build` / `bun run dev` at the root are shortcuts for the
  `packages/web` scripts.

CI (`.github/workflows/validate.yml`) runs `bun run lint` and `bun validate` on
PRs to `dev`. Pushes to `dev` deploy via `bun sst deploy --stage=dev`.

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
  maps to add SKUs/regions. The API does **not** publish GPU count, vCPU or RAM,
  so the instance map holds them too — never invent them, since a wrong
  `gpus_per_instance` corrupts every `$/GPU/hr` on the site.
- Each sync deletes every `providers/azure/gpus/*.toml` before it writes the new
  set, so a SKU removed from the map disappears. New `regions/<slug>` files get
  `name` + `area` only; existing region files are never overwritten.
- Partitioned GPUs are included with a fractional `gpus_per_instance` (1/6, 1/3,
  1/2 of an A10; 0.25 / 0.5 of an RTX PRO 6000).
- All Azure GPU VMs are N-series, so `startswith(armSkuName,'Standard_N')` acts
  as the GPU filter (the API has no category field).
- **Every** Azure region an offering sells in gets its own `[[availability]]`
  entry with the native code in `provider_region`. Several native regions can
  share one slug (`eastus` and `eastus2` are both `us-east`) and each keeps its
  own price — do not collapse them, or regions silently disappear from the site.
- Deliberately excluded: undocumented `f`/`flex` capacity-pool variants that
  duplicate a documented SKU at an identical price, re-metered aliases,
  non-GPU N-series (FPGA `NP`, media-accelerator `NM`) sizes, and any SKU whose
  GPU count Microsoft does not document (e.g. NCads A10 v4, RTX PRO 6000 v6
  sizes missing from the pricing-calculator feed).

## Code Style
- **Runtime**: Bun with TypeScript ESM modules.
- **Imports**: use `.js` extensions for local imports (e.g. `./schema.js`).
- **Types**: Zod schemas for validation, `z.infer<typeof Schema>` for inferred types.
- **Error handling**: `safeParse()` with a structured `error.cause` (`{ path, toml }`).
- **File ops**: Bun native APIs (`Bun.Glob`, `Bun.file`, `Bun.write`).

### Lint rules that shape the code
`.oxlintrc.json` enables strict anti-slop rules as errors. Notable ones: no
object parameters, no `unknown` parameters / returns / type aliases, no chained
or widen-then-assert type assertions, every type assertion needs a safety
comment, no runtime `typeof` checks, no module mocking, no unsafe dictionary
types. Parse external data with Zod at the boundary instead of asserting types.

## Architecture
Data (TOML in `gpus/`, `providers/`, `regions/`) → site → worker:

1. **`packages/core`** — `generateCatalog(root)` (`src/generate.ts`) globs the
   TOML, injects IDs from paths, resolves `base_gpu`, and cross-validates
   regions. Schemas are in `src/schema.ts`. The package is consumed as source
   (`main: ./src/index.ts`), so there is no build step. Workspace packages are
   still named `@models.dev/*` (fork history).
2. **`packages/web`** — `src/render.tsx` runs `generateCatalog` at module load
   (top-level `await`) and server-renders every page with Hono JSX into
   `RenderedPages`. `src/index.ts` is the client-side script (search index,
   sorting, virtual lists). `src/shared.ts` has formatters and HTML escaping.
   - `script/build.ts` bundles `index.html`, copies `public/` and logos
     (`providers/<id>/logo.svg` → `dist/logos/<id>.svg`,
     `gpus/<mfr>/logo.svg` → `dist/logos/gpus/<mfr>.svg`, with
     `providers/logo.svg` as `default.svg`), writes one `index.html` per route,
     and writes `_api.json`, `_gpus.json`, `_catalog.json` (underscore-prefixed).
   - `src/server.ts` is the dev server (port `PORT` ?? 3000, assets on
     `ASSET_PORT` ?? 16000) and mirrors the worker's routing.
3. **`packages/function/src/worker.ts`** — Cloudflare Worker in front of the
   static assets. It maps `/api.json`, `/gpus.json`, `/catalog.json` to the
   underscore files, `/` to `_index`, `/gpus|providers|regions/...` to
   `<path>/index.html`, falls back to `default.svg` for missing logos, and
   redirects other 404s to `/`. A new route type must be added both here and in
   `server.ts`.
4. **Deploy** — `sst.config.ts` runs the web build, then deploys the worker with
   `packages/web/dist` as assets (stage `dev` → `gpu.sidharth.party`).

## Data model

Three layers. IDs are always injected from the file path — never put `id` in a TOML file.

### Canonical GPUs — `gpus/<manufacturer>/<gpu>.toml`
Provider-agnostic facts about a GPU. `id` = path (e.g. `nvidia/h100-sxm`);
manufacturer = first path segment.

- Required: `name`, `vram_gb` (per single GPU).
- Optional: `description`, `family`, `architecture`, `memory_type`, `memory_bandwidth_gbs`,
  `tdp_watts`, `interconnect` (GPU-native scale-up link, e.g. `NVLink 4`),
  `release_date`, `last_updated`, `links`, and `[compute]`.
- `family` groups variants of one GPU (e.g. `a100-40gb`, `a100-sxm`, `a100-pcie`
  all set `family = "a100"`) so the GPUs table shows one row per family.
- `[compute]` holds **dense (non-sparse)** peak throughput: `fp64`, `tf32`, `fp16`,
  `bf16`, `fp8`, `fp4` in TFLOPS and `int8` in TOPS. Do not use with-sparsity
  figures (they are 2× the dense values).

### Provider offerings — `providers/<id>/gpus/<gpu>.toml`
A concrete instance/SKU with pricing.

- Required: `instance`, `gpus_per_instance` (number > 0; fractional values are
  valid for partitioned GPUs, e.g. `0.25`), `availability[]`
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
  replaced by the offering; omitted fields are inherited verbatim, except
  `links`, which is never inherited.
- `base_gpu_omit` runs after the merge and deletes each dot-path; ancestor tables
  that become empty are pruned.
- The resolved provider JSON contains no `base_gpu` / `base_gpu_omit`.

### Regions — `regions/<slug>/region.toml`
- Required: `name`. Optional: `location`, `area` (top-level grouping for the
  regions view, e.g. `North America`). `id` = directory name.
- Every offering `availability.region` must match a region slug, or validation
  fails. (The check is skipped only when `regions/` is empty.)

### Providers — `providers/<id>/provider.toml`
- Required: `name`, `doc` (URL), `type` (`cloud` | `neocloud` | `marketplace`).
- Optional: `api` (URL). `gpus` is populated during generation — do not author it.
- Provider `name` must be unique across providers (case-insensitive), or
  validation fails.

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
