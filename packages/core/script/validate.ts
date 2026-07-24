#!/usr/bin/env bun

import { generateCatalog } from "../src/generate";
import path from "path";
import { ZodError } from "zod";

try {
  const result = await generateCatalog(
    path.join(import.meta.dirname, "..", "..", ".."),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (e: any) {
  if (e instanceof ZodError) {
    console.error("Validation error:", e.errors);
    console.error("When parsing:", e.cause);
    process.exit(1);
  }
  throw e;
}
