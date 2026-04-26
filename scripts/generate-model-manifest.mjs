import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const modelsDir = path.resolve(process.cwd(), "public", "models");
const manifestPath = path.join(modelsDir, "models.json");

const entries = await readdir(modelsDir, { withFileTypes: true });
const models = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".glb"))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

const manifest = {
  models,
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Generated ${manifestPath} with ${models.length} model(s).`);