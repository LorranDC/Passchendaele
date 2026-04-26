import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";

const root = process.cwd();
const modelsDir = path.resolve(root, "public", "models");
const generatorScript = path.resolve(root, "scripts", "generate-model-manifest.mjs");
const viteBin = path.resolve(root, "node_modules", "vite", "bin", "vite.js");

const runNodeScript = (scriptPath) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
  });

let generating = false;
let pending = false;

const regenerateManifest = async () => {
  if (generating) {
    pending = true;
    return;
  }

  generating = true;
  do {
    pending = false;
    await runNodeScript(generatorScript);
  } while (pending);
  generating = false;
};

await regenerateManifest();

const vite = spawn(process.execPath, [viteBin], { stdio: "inherit" });

const watcher = watch(modelsDir, (_eventType, fileName) => {
  if (!fileName) return;
  const file = String(fileName).toLowerCase();
  if (file.endsWith(".glb")) {
    void regenerateManifest();
  }
});

const shutdown = () => {
  watcher.close();
  if (!vite.killed) {
    vite.kill();
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

vite.on("exit", (code) => {
  watcher.close();
  process.exit(code ?? 0);
});