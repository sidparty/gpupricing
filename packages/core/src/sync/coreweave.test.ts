import path from "path";
import { describe, expect, test } from "bun:test";

import { generateGpus } from "../generate.js";
import type { GpuMetadata } from "../schema.js";
import {
  buildOfferings,
  parsePricingPage,
  SKUS,
  type CoreWeaveSku,
} from "./coreweave.js";

// A small page in the markup of https://www.coreweave.com/pricing: two
// region tables under the GPU heading, each row with its mobile-layout copy
// mid-row and the page's whitespace inside cells, then a CPU table and a
// product modal that reuse the same markup.

const CONTACT = `<div></div>\n\t<a href="/contact-us" class="table-pricing-url">Contact sales</a>`;

function cell(content: string): string {
  const inner = content.startsWith("<") ? content : `<div>${content}</div>`;
  return `\n\t<div class="table-v2-cell">\n\t\t${inner}\n\t</div>`;
}

function row(product: string, name: string, values: string[]): string {
  const mobile = `<div class="table-cell-column table-cell-column-left"><h3 data-product="${product}" class="table-model-name">${name}</h3><div class="table-meta-value">999</div></div>`;
  return `<div role="listitem" class="table-row-v2 w-dyn-item"><div class="w-embed"><div class="table-grid">
    <div class="table-v2-cell table-v2-cell--name">\n\t\t<h3 data-product="${product}" class="table-model-name">${name}</h3>\n\t</div>
    ${values.slice(0, 6).map(cell).join("")}${mobile}${values.slice(6).map(cell).join("")}
  </div></div></div>`;
}

function table(label: string, headers: string[], rows: string[]): string {
  const head = headers
    .map((header) => `<div class="table-v2-cell"><div class="table-header-text">${header}</div></div>`)
    .join("");
  return `<div class="section-content"><h5><strong class="eyebrow">${label}</strong></h5>
    <div class="table-v2 gpu-pricing"><div class="table-v2-header"><div class="table-grid">${head}</div></div>
    <div class="table-v2-body w-dyn-list"><div role="list" class="w-dyn-items">${rows.join("")}</div></div></div></div>`;
}

const NA_HEADERS = [
  "GPU Model",
  "GPU Count",
  "VRAM (GB)",
  "vCPUs",
  "System RAM<br/>(GB)",
  "Local Storage<br/>(TB)",
  "On-Demand Price (Per Hour)",
  "Spot Price (Per Hour)",
  "Inference Single GPU Price(Per Hour)²",
];
const EU_HEADERS = NA_HEADERS.slice(0, 8);

const EU_H100 = row("hgx-h100", "NVIDIA HGX H100", ["8", "80", "128", "2,048", "61.44", "$49.24", "$19.51"]);

const NA_ROWS = [
  row("nvidia-gb300-nvl72", "NVIDIA GB300 NVL72", ["4^1", "279", "144", "960", "61.44", CONTACT, "N/A", CONTACT]),
  row("hgx-h100", "NVIDIA HGX H100", ["8", "80", "128", "2,048", "61.44", "$49.24", "$19.71", "$6.16"]),
  row("nvidia-l40", "NVIDIA L40", ["8", "48", "128", "1,024", "7.68", "$10.00", "$6.27", "$1.25"]),
  row("rtx-sm", "NVIDIA RTX PRO 6000 (Standard Memory)", ["8", "96", "128", "512", "7.68", CONTACT, "$9.56", CONTACT]),
  row("nvidia-x9000", "NVIDIA X9000", ["8", "200", "128", "2,048", "61.44", "$99.00", "N/A", "$12.38"]),
];
const EU_ROWS = [
  row("nvidia-gb300-nvl72", "NVIDIA GB300 NVL72", ["4^1", "279", "144", "960", "61.44", CONTACT, "N/A"]),
  EU_H100,
  row("nvidia-l40", "NVIDIA L40", ["8", "48", "128", "1,024", "7.68", "$10.00", "N/A"]),
  row("rtx-sm", "NVIDIA RTX PRO 6000 (Standard Memory)", ["8", "96", "128", "512", "7.68", CONTACT, "$9.56"]),
];

function page(gpuHeading = "On-demand GPU instances"): string {
  const cpu = table(
    "REGION: NORTH AMERICA",
    ["CPU Model", "CPU Type", "vCPUs", "System RAM (GB)", "Local Storage (TB)", "On-Demand Price (Per Hour)", "Spot Price (Per Hour)"],
    [row("amd-genoa-9274f", "AMD Genoa (9274F)", ["High Performance", "96", "768", "7.68", "$6.42", "$3.50"])],
  );
  return `<!DOCTYPE html><html><body><main>
    <section><header><h2 class="heading-32-20">${gpuHeading}</h2></header>
      ${table("REGION: NORTH AMERICA", NA_HEADERS, NA_ROWS)}
      ${table("REGION: EUROPE", EU_HEADERS, EU_ROWS)}
    </section>
    <section><header><h2>On-demand CPU instances</h2></header>${cpu}</section>
    <section><h2>Managed Kubernetes</h2><a href="#" data-product="hgx-h100">HGX H100</a></section>
  </main></body></html>`;
}

function gpu(id: string, vramGb: number): GpuMetadata {
  return { id, name: id, vram_gb: vramGb };
}

const GPUS = {
  "nvidia/gb300-nvl72": gpu("nvidia/gb300-nvl72", 279),
  "nvidia/h100-sxm": gpu("nvidia/h100-sxm", 80),
  "nvidia/l40": gpu("nvidia/l40", 48),
  "nvidia/rtx-pro-6000-blackwell": gpu("nvidia/rtx-pro-6000-blackwell", 96),
} satisfies Record<string, GpuMetadata>;

const TEST_SKUS: CoreWeaveSku[] = [
  { product: "nvidia-gb300-nvl72", id: "gb300-nvl72", baseGpu: "nvidia/gb300-nvl72", fabric: "NVLink", notes: ["A rack slice."] },
  { product: "hgx-h100", id: "h100-sxm", baseGpu: "nvidia/h100-sxm", fabric: "InfiniBand" },
  { product: "nvidia-l40", id: "l40", baseGpu: "nvidia/l40", fabric: "Ethernet" },
  { product: "rtx-sm", id: "rtx-sm", baseGpu: "nvidia/rtx-pro-6000-blackwell", fabric: "Ethernet" },
];

async function build(html: string, gpus = GPUS, skus = TEST_SKUS) {
  return buildOfferings(await parsePricingPage(html), gpus, skus);
}

async function offering(id: string) {
  const { offerings } = await build(page());
  return offerings.find((found) => found.id === id);
}

describe("parsePricingPage", () => {
  test("reads only the desktop cells of the GPU tables", async () => {
    const tables = await parsePricingPage(page());

    expect(tables.map((found) => found.label)).toEqual([
      "REGION: NORTH AMERICA",
      "REGION: EUROPE",
    ]);
    expect(tables[0]?.headers).toEqual([
      "GPU Model",
      "GPU Count",
      "VRAM (GB)",
      "vCPUs",
      "System RAM (GB)",
      "Local Storage (TB)",
      "On-Demand Price (Per Hour)",
      "Spot Price (Per Hour)",
      "Inference Single GPU Price(Per Hour)²",
    ]);
    expect(tables[0]?.rows[0]).toEqual({
      product: "nvidia-gb300-nvl72",
      cells: ["NVIDIA GB300 NVL72", "4^1", "279", "144", "960", "61.44", "Contact sales", "N/A", "Contact sales"],
    });
    expect(tables[1]?.rows.map((found) => found.product)).toEqual([
      "nvidia-gb300-nvl72",
      "hgx-h100",
      "nvidia-l40",
      "rtx-sm",
    ]);
  });

  test("keeps adjacent elements apart and reads <sup> as a footnote", async () => {
    const html = page()
      .replace(cell("4^1"), cell("4<sup>1</sup>"))
      .replace(cell("$19.71"), cell(`<div>$19.71</div><a href="#fn">2</a>`))
      .replaceAll("NVIDIA HGX H100", "NVIDIA HGX H100 &amp; NVLink");
    const tables = await parsePricingPage(html);

    expect(tables[0]?.rows[0]?.cells[1]).toBe("4^1");
    expect(tables[0]?.rows[1]?.cells[7]).toBe("$19.71 2");
    expect(tables[0]?.rows[1]?.cells[0]).toBe("NVIDIA HGX H100 & NVLink");
  });

  test("leaves out rows that Webflow hides", async () => {
    const html = page().replace(
      `<div role="listitem" class="table-row-v2 w-dyn-item"><div class="w-embed"><div class="table-grid">
    <div class="table-v2-cell table-v2-cell--name">\n\t\t<h3 data-product="nvidia-x9000"`,
      `<div role="listitem" class="table-row-v2 w-dyn-item"><div class="w-embed w-condition-invisible"><div class="table-grid">
    <div class="table-v2-cell table-v2-cell--name">\n\t\t<h3 data-product="nvidia-x9000"`,
    );
    const tables = await parsePricingPage(html);

    expect(tables[0]?.rows.map((found) => found.product)).not.toContain("nvidia-x9000");
  });

  test("fails on a paginated table", async () => {
    const html = page().replace(
      `</div></div></div></div>
    </section>`,
      `</div><div class="w-pagination-wrapper"></div></div></div></div>
    </section>`,
    );

    await expect(parsePricingPage(html)).rejects.toThrow("paginated");
  });
});

describe("buildOfferings", () => {
  test("puts an on-demand price every region shares in [cost]", async () => {
    expect(await offering("h100-sxm")).toEqual({
      id: "h100-sxm",
      instance: "HGX H100",
      baseGpu: "nvidia/h100-sxm",
      gpusPerInstance: 8,
      vcpus: 128,
      memoryGb: 2048,
      localStorageGb: 61_440,
      fabric: "InfiniBand",
      notes: [],
      cost: { hourly: 49.24 },
      availability: [
        { region: "north-america", spotHourly: 19.71 },
        { region: "europe", spotHourly: 19.51 },
      ],
    });
  });

  test("puts a spot price every region shares in [cost]", async () => {
    const rtx = await offering("rtx-sm");

    expect(rtx?.cost).toEqual({ spotHourly: 9.56 });
    expect(rtx?.cost?.hourly).toBeUndefined();
    expect(rtx?.availability).toEqual([
      { region: "north-america" },
      { region: "europe" },
    ]);
  });

  test("keeps a price a region lacks per region", async () => {
    const l40 = await offering("l40");

    expect(l40?.cost).toEqual({ hourly: 10 });
    expect(l40?.availability).toEqual([
      { region: "north-america", spotHourly: 6.27 },
      { region: "europe" },
    ]);
  });

  test("leaves a contact-sales product unpriced and strips the footnote", async () => {
    const gb300 = await offering("gb300-nvl72");

    expect(gb300?.gpusPerInstance).toBe(4);
    expect(gb300?.cost).toBeUndefined();
    expect(gb300?.availability).toEqual([
      { region: "north-america" },
      { region: "europe" },
    ]);
    expect(gb300?.notes).toEqual(["A rack slice."]);
  });

  test("strips footnotes and trademark signs from the instance name", async () => {
    const html = page().replaceAll(
      ">NVIDIA HGX H100<",
      ">NVIDIA&reg; HGX H100<sup>3</sup><",
    );
    const { offerings } = await build(html);

    expect(offerings.find((found) => found.id === "h100-sxm")?.instance).toBe("HGX H100");
  });

  test("warns about an unmapped product and skips it", async () => {
    const { offerings, warnings } = await build(page());

    expect(offerings.map((found) => found.id)).toEqual([
      "gb300-nvl72",
      "h100-sxm",
      "l40",
      "rtx-sm",
    ]);
    expect(warnings).toEqual([
      '"nvidia-x9000" (NVIDIA X9000) is not in SKUS, so it is skipped. Add it to SKUS in coreweave.ts.',
    ]);
  });

  test("warns about an unmapped region label and skips its table", async () => {
    const html = page().replace(
      table("REGION: EUROPE", EU_HEADERS, EU_ROWS),
      `${table("REGION: EUROPE", EU_HEADERS, EU_ROWS)}${table("REGION: ASIA", EU_HEADERS, EU_ROWS)}`,
    );
    const { offerings, warnings } = await build(html);

    expect(warnings).toContainEqual(expect.stringContaining('"REGION: ASIA" is not in REGIONS'));
    expect(offerings[0]?.availability.map((entry) => entry.region)).toEqual(["north-america", "europe"]);
  });

  test("fails when a product in SKUS is not on the page", async () => {
    const html = page().replaceAll('data-product="hgx-h100"', 'data-product="nvidia-hgx-h100"');

    await expect(build(html)).rejects.toThrow(
      /Not on the pricing page: "hgx-h100" \(h100-sxm\)\..*"nvidia-hgx-h100" \(NVIDIA HGX H100\)/,
    );
  });

  test("fails when a region in REGIONS has no table", async () => {
    const html = page().replace("REGION: EUROPE", "REGION: EMEA");

    await expect(build(html)).rejects.toThrow("No GPU table maps to europe");
  });

  test("fails when a heading hides a region table", async () => {
    const html = page().replace(
      `<div class="section-content"><h5><strong class="eyebrow">REGION: EUROPE`,
      `<h2>Europe</h2><div class="section-content"><h5><strong class="eyebrow">REGION: EUROPE`,
    );

    await expect(build(html)).rejects.toThrow("No GPU table maps to europe");
  });

  test("fails when a region table is empty", async () => {
    const html = page().replace(table("REGION: EUROPE", EU_HEADERS, EU_ROWS), table("REGION: EUROPE", EU_HEADERS, []));

    await expect(build(html)).rejects.toThrow("REGION: EUROPE: the GPU table has no rows");
  });

  test("fails when a table has no region label", async () => {
    const html = page().replace(`<h5><strong class="eyebrow">REGION: EUROPE</strong></h5>`, "");

    await expect(build(html)).rejects.toThrow('A GPU table has no "REGION: ..." label');
  });

  test("fails when the single-GPU price disagrees with the GPU count", async () => {
    await expect(build(page().replace("$6.16", "$12.31"))).rejects.toThrow(
      "h100-sxm: in north-america the single-GPU price $12.31 is not $49.24 / 8 GPUs",
    );
  });

  test("fails when a required column is missing", async () => {
    const html = page().replace(
      `<div class="table-header-text">Spot Price (Per Hour)</div>`,
      `<div class="table-header-text">Spot (Hourly)</div>`,
    );

    await expect(build(html)).rejects.toThrow('the "Spot Price (Per Hour)" column is missing');
  });

  test("fails when a column appears twice", async () => {
    const html = page().replace(
      `<div class="table-header-text">vCPUs</div>`,
      `<div class="table-header-text">GPU Count</div>`,
    );

    await expect(build(html)).rejects.toThrow('the "GPU Count" column appears twice');
  });

  test.each(["Call us", "$49,24", "", "From $40.00"])(
    "fails on the price cell %p",
    async (price) => {
      await expect(build(page().replace(cell("$49.24"), cell(price)))).rejects.toThrow(
        `found "${price}"`,
      );
    },
  );

  test("fails when a row has more cells than headers", async () => {
    const html = page().replace(cell("$19.71"), `${cell("$19.71")}${cell("extra")}`);

    await expect(build(html)).rejects.toThrow("10 cells under 9 headers");
  });

  test("fails when a row has no data-product", async () => {
    // The slug sits on the desktop name and on its mobile copy.
    const html = page().replaceAll(
      `<h3 data-product="nvidia-l40" class="table-model-name">`,
      `<h3 class="table-model-name">`,
    );

    await expect(build(html)).rejects.toThrow("has no data-product slug");
  });

  test("fails when a product is listed twice in one table", async () => {
    const html = page().replace(EU_H100, `${EU_H100}${EU_H100}`);

    await expect(build(html)).rejects.toThrow('"hgx-h100" is listed twice');
  });

  test("fails when two tables map to one region", async () => {
    const html = page().replace("REGION: EUROPE", "REGION: NORTH AMERICA");

    await expect(build(html)).rejects.toThrow('Two GPU tables map to the region "north-america"');
  });

  test.each([
    ["gpuCount", 0, "4"],
    ["vramGb", 1, "94"],
    ["vcpus", 2, "96"],
    ["memoryGb", 3, "1,024"],
    ["localStorageTb", 4, "30.72"],
  ])("fails when the regions disagree on %s", async (field, index, value) => {
    const values = ["8", "80", "128", "2,048", "61.44", "$49.24", "$19.51"];
    values[index] = value;
    const html = page().replace(EU_H100, row("hgx-h100", "NVIDIA HGX H100", values));

    await expect(build(html)).rejects.toThrow(`h100-sxm: ${field} is`);
  });

  test("fails when the page VRAM disagrees with the base GPU", async () => {
    const gpus = { ...GPUS, "nvidia/h100-sxm": gpu("nvidia/h100-sxm", 94) };

    await expect(build(page(), gpus)).rejects.toThrow("lists 80 GB of VRAM per GPU");
  });

  test("fails when two SKUS entries share an id", async () => {
    const skus = [...TEST_SKUS, { product: "nvidia-x9000", id: "l40", baseGpu: "nvidia/l40", fabric: "Ethernet" }];

    await expect(build(page(), GPUS, skus)).rejects.toThrow("SKUS repeats the id l40");
  });

  test("fails when the GPU section is gone", async () => {
    await expect(build(page("GPU instances"))).rejects.toThrow("Found no GPU table");
  });
});

describe("SKUS", () => {
  test("maps every product to an existing canonical GPU, once", async () => {
    const gpus = await generateGpus(path.join(import.meta.dirname, "..", "..", "..", "..", "gpus"));

    expect(SKUS.filter((sku) => gpus[sku.baseGpu] === undefined)).toEqual([]);
    expect(new Set(SKUS.map((sku) => sku.id)).size).toBe(SKUS.length);
    expect(new Set(SKUS.map((sku) => sku.product)).size).toBe(SKUS.length);
  });
});
