import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";
import { checkPackagedNodeHidLoad } from "./packaged-native-load-check.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");

console.log("\nLaunching Electron smoke test...");

const electronCommand = resolveElectronLaunchCommand([mainJs]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => {
  child.kill();
}, 8_000);

child.on("exit", () => {
  clearTimeout(timeout);

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));

  let exitCode = 0;

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    exitCode = 1;
  } else {
    console.log("Desktop smoke test passed.");
  }

  // The check above only exercises the dev tree (dist-electron/main.cjs), which
  // never goes through asar packing/unpacking. Run the distinct packaged
  // native-load gate too: if a packaged artifact exists on disk (e.g. from
  // scripts/build-desktop-artifact.ts), verify node-hid actually loads from its
  // unpacked node_modules. See packaged-native-load-check.mjs for details.
  console.log("\nChecking packaged node-hid native load (Codex Micro)...");
  const packagedCheck = checkPackagedNodeHidLoad();
  console.log(packagedCheck.message);
  if (!packagedCheck.ok) {
    exitCode = 1;
  }

  process.exit(exitCode);
});
