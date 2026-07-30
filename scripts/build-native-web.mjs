import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
const supabaseBundle = join(
  root,
  "node_modules",
  "@supabase",
  "supabase-js",
  "dist",
  "umd",
  "supabase.js"
);

async function requireFile(path, label) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`${label} is missing. Run npm install before building native assets.`);
  }
}

await requireFile(supabaseBundle, "The local Supabase browser bundle");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "vendor"), { recursive: true });

for (const entry of ["js", "assets", "legal"]) {
  await cp(join(root, entry), join(output, entry), { recursive: true });
}
await cp(join(root, "manifest.webmanifest"), join(output, "manifest.webmanifest"));
await cp(supabaseBundle, join(output, "vendor", "supabase.js"));

const sourceHtml = await readFile(join(root, "index.html"), "utf8");
const nativeHtml = sourceHtml.replace(
  '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
  '<script src="vendor/supabase.js"></script>'
);

if (nativeHtml === sourceHtml) {
  throw new Error("Could not replace the Supabase CDN script in the native build.");
}

await writeFile(join(output, "index.html"), nativeHtml);
console.log("Native web assets built in dist/.");
