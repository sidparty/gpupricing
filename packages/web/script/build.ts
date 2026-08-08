#!/usr/bin/env bun

import {
  RenderedPages,
  Providers,
  Gpus,
  Regions,
  renderDocument,
} from "../src/render";
import fs from "fs/promises";
import path from "path";

await fs.rm("./dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  target: "bun",
});

for await (const file of new Bun.Glob("./public/*").scan()) {
  await Bun.write(file.replace("./public/", "./dist/"), Bun.file(file));
}

// Copy provider logos to dist/logos/
await fs.mkdir("./dist/logos", { recursive: true });

// First, copy the default logo
const defaultLogoPath = "../../providers/logo.svg";
const defaultLogo = Bun.file(defaultLogoPath);
if (await defaultLogo.exists()) {
  await Bun.write("./dist/logos/default.svg", defaultLogo);
}

// Then copy provider-specific logos
const providersDir = "../../providers";
const entries = await fs.readdir(providersDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) {
    const provider = entry.name;
    const logoPath = path.join(providersDir, provider, "logo.svg");
    const logoFile = Bun.file(logoPath);

    if (await logoFile.exists()) {
      await Bun.write(`./dist/logos/${provider}.svg`, logoFile);
    }
  }
}

// Copy GPU manufacturer logos to dist/logos/gpus/
await fs.mkdir("./dist/logos/gpus", { recursive: true });

const gpusDir = "../../gpus";
try {
  for (const entry of await fs.readdir(gpusDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const logoFile = Bun.file(path.join(gpusDir, entry.name, "logo.svg"));
    if (await logoFile.exists()) {
      await Bun.write(`./dist/logos/gpus/${entry.name}.svg`, logoFile);
    }
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const template = await Bun.file("./dist/index.html").text();

for (const [route, rendered] of RenderedPages) {
  const filePath = route === "/"
    ? "./dist/_index.html"
    : path.join("./dist", route, "index.html");

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, renderDocument(template, rendered));
}

await Bun.write("./dist/api.json", JSON.stringify(Providers));
await Bun.write(
  "./dist/catalog.json",
  JSON.stringify({ gpus: Gpus, providers: Providers, regions: Regions }),
);
await Bun.write("./dist/gpus.json", JSON.stringify(Gpus));

await fs.rename("./dist/api.json", "./dist/_api.json");
await fs.rename("./dist/catalog.json", "./dist/_catalog.json");
await fs.rename("./dist/gpus.json", "./dist/_gpus.json");

await fs.rm("./dist/index.html", { force: true });
