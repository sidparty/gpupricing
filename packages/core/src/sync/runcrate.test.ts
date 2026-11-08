import { describe, expect, test } from "bun:test";

import { RuncrateFeed, buildOfferings } from "./runcrate.js";

// Trimmed from https://www.runcrate.ai/api/gpu-pricing on 2026-11-08. The
// L40S entry is edited: its stock is zeroed and one location is replaced with
// a made-up one, to cover the skip paths.
const fixture = RuncrateFeed.parse({
  gpus: [
    {
      gpu_type: "B300",
      min_price_hr: 16.47,
      available_options: 3,
      regions: ["Dublin, Ireland", "Boston, MA, United States"],
    },
    {
      gpu_type: "H200",
      min_price_hr: 5.13,
      available_options: 15,
      regions: [
        "Helsinki, Finland",
        "Finland 1",
        "Kagawa, Japan",
        "Nowhere, Atlantis",
      ],
    },
    {
      gpu_type: "H100",
      min_price_hr: 3.58,
      available_options: 15,
      regions: ["New York, NY, United States"],
    },
    {
      gpu_type: "L40S",
      min_price_hr: 0.55,
      available_options: 0,
      regions: ["Warsaw, Poland"],
    },
  ],
});

describe("buildOfferings", () => {
  const result = buildOfferings(fixture);

  test("maps a stocked GPU to its canonical entry at the feed price", () => {
    const b300 = result.offerings.find((o) => o.id === "b300");
    expect(b300?.baseGpu).toBe("nvidia/b300");
    expect(b300?.hourly).toBe(16.47);
    expect(b300?.gpusPerInstance).toBe(1);
    expect(b300?.availability).toEqual([
      { region: "eu-west", providerRegion: "Dublin, Ireland" },
      { region: "us-east", providerRegion: "Boston, MA, United States" },
    ]);
  });

  test("keeps the H200 as the SXM part and each native location", () => {
    const h200 = result.offerings.find((o) => o.id === "h200-sxm");
    expect(h200?.baseGpu).toBe("nvidia/h200-sxm");
    expect(h200?.availability.map((a) => a.providerRegion)).toEqual([
      "Kagawa, Japan",
      "Finland 1",
      "Helsinki, Finland",
    ]);
  });

  test("reports locations it cannot place instead of guessing", () => {
    expect(result.unmapped).toEqual(["Nowhere, Atlantis"]);
  });

  test("never lists types that are ambiguous or out of stock", () => {
    expect(result.offerings.map((o) => o.id)).toEqual(["b300", "h200-sxm"]);
    expect(result.skipped).toContain("L40S: no options in stock");
  });

  test("only creates regions that an offering uses", () => {
    expect([...result.regions.keys()].sort()).toEqual([
      "ap-northeast",
      "eu-north",
      "eu-west",
      "us-east",
    ]);
  });
});
