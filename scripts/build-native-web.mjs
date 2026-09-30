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

// DEVELOPER-ONLY QA build (`npm run android:qa`): point /api traffic at a
// Vercel Preview. Off unless --qa is passed; the origin comes from the
// environment, never from source control.
let finalHtml = nativeHtml;
if (process.argv.includes("--qa")) {
  const qaOrigin = String(process.env.ATHLEVO_QA_API_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.vercel\.app$/.test(qaOrigin)) {
    throw new Error(
      "QA build needs ATHLEVO_QA_API_ORIGIN=https://<your-preview>.vercel.app (a Vercel Preview origin, no path)."
    );
  }
  const marker = '<script src="js/runtimeEnvironment.js';
  if (!nativeHtml.includes(marker)) throw new Error("Could not find runtimeEnvironment.js script tag.");
  finalHtml = nativeHtml.replace(
    marker,
    `<script>window.__ATHLEVO_QA_API_ORIGIN__=${JSON.stringify(qaOrigin)};</script>\n${marker}`
  );
  console.log(`QA build: /api requests will go to ${qaOrigin}`);
}

await writeFile(join(output, "index.html"), finalHtml);
console.log("Native web assets built in dist/.");
