/**
 * Dev server — watches server/ source files, rebuilds with rolldown,
 * waits for the old process to release the port, then starts the new one.
 *
 * Uses fs.watch directly for precise control over the rebuild+restart
 * sequence, avoiding the race conditions of combining rolldown --watch
 * with node --watch.
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const rolldownBin = resolve(__dirname, "node_modules", "rolldown", "bin", "cli.mjs");
const PORT = Number(process.env.PORT || 8787);

let child = null;
let timer = null;
let shuttingDown = false;
let ready = false;

function log(...args) {
  console.log("[dev]", ...args);
}

function build() {
  return new Promise((resolve, reject) => {
    log("Rebuilding…");
    const proc = spawn(process.execPath, [rolldownBin, "-c", "rolldown.server.config.mjs"], {
      stdio: "inherit",
    });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(Error(`rolldown exited ${code}`))));
    proc.on("error", reject);
  });
}

function start() {
  return new Promise((resolve) => {
    log("Starting…");
    ready = false;
    child = spawn(process.execPath, ["dist-server/index.mjs", "--dev"], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      child = null;
      if (!shuttingDown) log(`Exited (${code}), waiting for changes…`);
    });
    child.on("error", () => { child = null; });
    setTimeout(resolve, 300);
  });
}

/** Wait until the port is available (no longer listening). */
function waitForPortFree(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      if (Date.now() > deadline) return resolve();
      const socket = createConnection({ port: PORT, host: "127.0.0.1" }, () => {
        socket.end();
        setTimeout(check, 100);
      });
      socket.on("error", () => resolve()); // Connection refused → port is free
    }
    check();
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const proc = child;
    child = null;

    proc.on("exit", () => {
      waitForPortFree().then(resolve);
    });
    proc.on("error", () => resolve());
    proc.kill("SIGTERM");

    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      waitForPortFree().then(resolve);
    }, 3000);
  });
}

async function rebuildAndRestart() {
  if (shuttingDown) return;
  try {
    await stop();      // kill old + wait for port release
    await build();     // rebuild
    if (!shuttingDown) await start();  // start new
  } catch (err) {
    log(`Build failed: ${err.message}`);
  }
}

function onSourceChange(changeType, filename) {
  if (!filename) return;
  if (!ready) return; // Ignore stale events during startup/build
  // Skip test files, temp files, and sourcemaps
  if (filename.startsWith(".") || filename.endsWith(".test.ts") || filename.endsWith(".map")) {
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(rebuildAndRestart, 200);
}

async function main() {
  // 1. Build
  log("Building…");
  await build();

  // 2. Start server
  await start();

  // 3. Watch server/ source files
  log("Watching server/…");
  const watcher = watch("server", { recursive: true }, onSourceChange);

  // 4. Settle period — ignore watcher events for a bit after startup
  // to avoid stale filesystem events from the build process.
  // Vite HMR handles client-side hot reloading, so we never restart
  // for client/ changes.
  setTimeout(() => {
    ready = true;
    log("Ready — server and watcher settled");
  }, 3000);

  function cleanup() {
    shuttingDown = true;
    if (timer) clearTimeout(timer);
    watcher.close();
    if (child) child.kill("SIGTERM");
    process.exit();
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
