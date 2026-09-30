#!/usr/bin/env node
/**
 * One-shot encoder for storefront derivatives.
 * Reads original landing/diagnostic photos; writes WebP + AVIF under assets/store.
 * Does not modify or delete source files.
 *
 *   node --import file:///tmp/athlevo-sharp/node_modules/sharp/lib/index.js
 * is awkward; instead run with NODE_PATH=/tmp/athlevo-sharp/node_modules
 */
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/tmp/athlevo-sharp/package.json");
const sharp = require("sharp");
const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "assets/store");
mkdirSync(outDir, { recursive: true });

const sources = [
  { id: "training", file: "assets/landing/athlete-philosophy-training.png", hero: true },
  { id: "pack", file: "assets/landing/hero-athlevo.png" },
  { id: "founder", file: "assets/landing/dean-founder.png" },
  { id: "road", file: "athlevo-assets/diagnostic proof/640393536_17877223146489492_4744442913120713853_n.jpg" },
  { id: "track", file: "athlevo-assets/diagnostic proof/641749426_17877177045489492_4823496183798299753_n.jpg" }
];

const widths = [640, 1280];
const report = [];

function kb(bytes) {
  return Math.round(bytes / 102.4) / 10;
}

for (const source of sources) {
  const input = join(root, source.file);
  const meta = await sharp(input).metadata();
  const origBytes = statSync(input).size;
  report.push({
    id: source.id,
    original: source.file,
    originalKb: kb(origBytes),
    originalPx: meta.width + "×" + meta.height
  });

  for (const width of widths) {
    const target = Math.min(width, meta.width);
    const pipeline = () => sharp(input).rotate().resize({
      width: target,
      withoutEnlargement: true
    });
    const webpPath = join(outDir, `${source.id}-${target}.webp`);
    const avifPath = join(outDir, `${source.id}-${target}.avif`);
    const webpQuality = source.hero ? 82 : 76;
    const avifQuality = source.hero ? 52 : 48;
    await pipeline().webp({ quality: webpQuality, effort: 5 }).toFile(webpPath);
    await pipeline().avif({ quality: avifQuality, effort: 4 }).toFile(avifPath);
    const webpBytes = statSync(webpPath).size;
    const avifBytes = statSync(avifPath).size;
    report.push({
      id: source.id,
      variant: target,
      webpKb: kb(webpBytes),
      avifKb: kb(avifBytes)
    });
    if (source.hero && target >= 1200 && webpBytes > 500 * 1024) {
      await pipeline().webp({ quality: 64, effort: 6 }).toFile(webpPath);
      report[report.length - 1].webpKb = kb(statSync(webpPath).size);
      report[report.length - 1].webpNote = "re-encoded to stay under 500KB";
    }
  }
}

console.log(JSON.stringify(report, null, 2));
