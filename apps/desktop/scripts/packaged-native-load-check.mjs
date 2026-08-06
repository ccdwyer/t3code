// Packaging gate (Task T10 / Codex Micro): verifies the packaged Electron
// artifact can actually load `node-hid`'s native binding from disk, the way
// the desktop app does at runtime (see
// apps/desktop/src/devices/CodexMicroTransport.ts's lazy `import("node-hid")`).
//
// `scripts/build-desktop-artifact.ts` unpacks the whole `node_modules` tree
// from the asar (`asarUnpack: [..., "**/node_modules/**"]`), so node-hid's
// prebuilt `.node` binary ends up on the real filesystem under
// `<packaged app>/.../app.asar.unpacked/node_modules/node-hid/prebuilds/...`
// for every platform/arch electron-builder produces. Fake-transport unit
// tests never exercise that unpacked path, so this script does: it finds
// every `app.asar.unpacked` directory under the build output, and for each
// one spawns an isolated `node` child process that imports node-hid straight
// off disk and calls `devicesAsync()`. node-hid is a prebuilt N-API addon
// (ABI-stable across Electron and plain Node for a given NAPI version), so a
// plain `node` child process is a faithful stand-in for Electron's main
// process here — no Electron launch required.
//
// When no packaged artifact exists yet (the common case outside a release
// build), the check is skipped with a clear message rather than failing —
// but if an unpacked artifact IS present and node-hid fails to load from it,
// this fails loudly (non-zero exit).

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const repoRoot = NodePath.resolve(desktopDir, "..", "..");

const UNPACKED_DIR_NAME = "app.asar.unpacked";
const DEFAULT_SEARCH_MAX_DEPTH = 8;

/**
 * Release output roots that `scripts/build-desktop-artifact.ts` writes to
 * by default (its `resolveBuildOptions` picks `release` for a normal build
 * or `release-mock` for a mock-update build; either can be overridden via
 * `--output-dir` / `T3CODE_DESKTOP_OUTPUT_DIR`). Set
 * `T3CODE_DESKTOP_RELEASE_DIR` to point this check at a custom output dir
 * instead of searching both defaults.
 */
export function resolveReleaseSearchRoots(env = process.env) {
  const override = env.T3CODE_DESKTOP_RELEASE_DIR;
  if (override && override.trim().length > 0) {
    return [NodePath.resolve(repoRoot, override)];
  }
  return [NodePath.join(repoRoot, "release"), NodePath.join(repoRoot, "release-mock")];
}

/**
 * Recursively finds every `app.asar.unpacked` directory under `roots`. A
 * single packaged build can produce more than one (e.g. `mac-arm64` and
 * `mac-x64` unpacked app bundles side by side, or `win-unpacked` and
 * `win-arm64-unpacked`), so every match is returned rather than just the
 * first — the packaging gate must cover both arm64 and x64.
 */
export function findAppAsarUnpackedDirs(roots, maxDepth = DEFAULT_SEARCH_MAX_DEPTH) {
  const found = [];

  function walk(dir, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const entryPath = NodePath.join(dir, entry.name);
      if (entry.name === UNPACKED_DIR_NAME) {
        found.push(entryPath);
        continue; // Don't descend into the (large) unpacked tree itself.
      }
      walk(entryPath, depth + 1);
    }
  }

  for (const root of roots) {
    if (NodeFS.existsSync(root)) {
      walk(root, 0);
    }
  }

  return found;
}

/**
 * Resolves the on-disk `node-hid` package inside an unpacked asar
 * directory, returning its `main` entry as a `file://` URL, or `null` if
 * node-hid isn't present there at all (e.g. asarUnpack regressed, or the
 * artifact predates node-hid being a dependency).
 */
export function resolvePackagedNodeHidEntryUrl(unpackedDir) {
  const packageDir = NodePath.join(unpackedDir, "node_modules", "node-hid");
  const packageJsonPath = NodePath.join(packageDir, "package.json");
  if (!NodeFS.existsSync(packageJsonPath)) {
    return null;
  }
  const packageJson = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8"));
  const mainRelativePath = packageJson.main ?? "index.js";
  const mainPath = NodePath.join(packageDir, mainRelativePath);
  if (!NodeFS.existsSync(mainPath)) {
    return null;
  }
  return NodeURL.pathToFileURL(mainPath).href;
}

function buildChildCheckSource(entryUrl) {
  return [
    `const mod = await import(${JSON.stringify(entryUrl)});`,
    "const hid = mod && mod.default ? mod.default : mod;",
    'if (typeof hid.devicesAsync !== "function") {',
    '  console.error("node-hid devicesAsync is not a function: " + typeof hid.devicesAsync);',
    "  process.exit(1);",
    "}",
    "const devices = await hid.devicesAsync();",
    "if (!Array.isArray(devices)) {",
    '  console.error("node-hid devicesAsync() did not return an array: " + typeof devices);',
    "  process.exit(1);",
    "}",
    'console.log("node-hid packaged native load OK; devicesAsync() returned " + devices.length + " device(s).");',
  ].join("\n");
}

/**
 * Loads the packaged `node-hid` native module in an isolated child `node`
 * process and asserts `devicesAsync` is callable and returns an array.
 */
export function runPackagedNodeHidLoadCheck(
  entryUrl,
  { spawnSync = NodeChildProcess.spawnSync } = {},
) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", buildChildCheckSource(entryUrl)],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Classify a packaged artifact path by CPU arch from electron-builder's output
 * dir naming (e.g. `mac-arm64`, `mac-x64`, `linux-arm64-unpacked`,
 * `win-arm64-unpacked`). Returns `"arm64"` | `"x64"`, or `null` when the path
 * carries no arch marker — electron-builder's DEFAULT (host-arch) output dirs
 * (`mac`, `linux-unpacked`, `win-unpacked`) have none, so an unmarked tree is
 * treated as host-arch and always attempted.
 */
export function archForArtifactPath(artifactPath) {
  const lower = artifactPath.toLowerCase();
  if (lower.includes("arm64") || lower.includes("aarch64")) {
    return "arm64";
  }
  if (lower.includes("x64") || lower.includes("x86_64") || lower.includes("amd64")) {
    return "x64";
  }
  return null;
}

/** Normalize `process.arch` to the `arm64`/`x64` vocabulary used in dir names. */
export function resolveHostArch(arch = process.arch) {
  if (arch === "arm64") {
    return "arm64";
  }
  if (arch === "x64") {
    return "x64";
  }
  return arch;
}

/**
 * Strict (fail-closed) mode: when on, "no loadable artifact for this host" is a
 * FAILURE rather than a soft skip. Enabled by `T3_REQUIRE_PACKAGED_NATIVE_CHECK`
 * (1/true/yes) — wired into the release workflow, where every matrix runner
 * MUST have produced a host-arch artifact by this point.
 */
export function isStrictModeFromEnv(env = process.env) {
  const raw = (env.T3_REQUIRE_PACKAGED_NATIVE_CHECK ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Full packaging gate: locate packaged `app.asar.unpacked` directories, filter
 * out foreign-arch trees (E2 — host Node can't load a cross-arch prebuild), and
 * run the native-load check against each host-arch one found.
 *
 * Returns `{ ran, ok, message }`.
 *  - `ran: false, ok: true`  — no host-arch artifact exists (soft skip; the
 *    default outside a release build).
 *  - `ran: false, ok: false` — STRICT mode and no host-arch artifact (E1).
 *  - `ran: true,  ok: false` — an artifact was found and node-hid failed to load.
 *  - `ran: true,  ok: true`  — node-hid loaded from every host-arch artifact.
 *
 * `hostArch` and `requireArtifact` are injectable for tests; they default to
 * `process.arch` and the `T3_REQUIRE_PACKAGED_NATIVE_CHECK` env var.
 */
export function checkPackagedNodeHidLoad({
  env = process.env,
  spawnSync,
  hostArch,
  requireArtifact,
} = {}) {
  const roots = resolveReleaseSearchRoots(env);
  const allUnpackedDirs = findAppAsarUnpackedDirs(roots);
  const resolvedHostArch = hostArch ?? resolveHostArch();
  const strict = requireArtifact ?? isStrictModeFromEnv(env);

  // E2: keep only host-arch (or arch-agnostic) trees; skip foreign-arch ones.
  const runnableDirs = [];
  const skippedNotes = [];
  for (const unpackedDir of allUnpackedDirs) {
    const arch = archForArtifactPath(unpackedDir);
    if (arch !== null && arch !== resolvedHostArch) {
      skippedNotes.push(
        `${unpackedDir}: built for ${arch}, host is ${resolvedHostArch} — skipped (host-Node cannot load a cross-arch native prebuild; verify it on a ${arch} runner).`,
      );
      continue;
    }
    runnableDirs.push(unpackedDir);
  }

  const skippedSection =
    skippedNotes.length > 0
      ? ["Skipped foreign-arch artifacts:", ...skippedNotes.map((line) => ` - ${line}`)]
      : [];

  if (runnableDirs.length === 0) {
    if (strict) {
      return {
        ran: false,
        ok: false,
        message: [
          `Packaged node-hid native-load check REQUIRED (strict mode) but no loadable ${resolvedHostArch} artifact was found under ${roots.join(", ")}. Build the desktop artifact for this host first.`,
          ...skippedSection,
        ].join("\n"),
      };
    }
    return {
      ran: false,
      ok: true,
      message: [
        `No packaged desktop artifact found under ${roots.join(", ")} — skipping the packaged node-hid native-load check. Build one first (e.g. \`vp exec --filter scripts -- tsx scripts/build-desktop-artifact.ts\`), then re-run this check to actually exercise it.`,
        ...skippedSection,
      ].join("\n"),
    };
  }

  const failures = [];
  const successes = [];

  for (const unpackedDir of runnableDirs) {
    const entryUrl = resolvePackagedNodeHidEntryUrl(unpackedDir);
    if (!entryUrl) {
      failures.push(
        `${unpackedDir}: node-hid is missing from the unpacked node_modules (expected node_modules/node-hid to exist there — asarUnpack regression?).`,
      );
      continue;
    }
    const result = runPackagedNodeHidLoadCheck(entryUrl, { spawnSync });
    if (result.status !== 0) {
      failures.push(
        `${unpackedDir}: ${result.stderr.trim() || result.stdout.trim() || `child process exited with status ${result.status}`}`,
      );
      continue;
    }
    successes.push(`${unpackedDir}: ${result.stdout.trim()}`);
  }

  if (failures.length > 0) {
    return {
      ran: true,
      ok: false,
      message: [
        "Packaged node-hid native-load check FAILED:",
        ...failures.map((line) => ` - ${line}`),
        ...(successes.length > 0 ? ["Passed:", ...successes.map((line) => ` - ${line}`)] : []),
        ...skippedSection,
      ].join("\n"),
    };
  }

  return {
    ran: true,
    ok: true,
    message: [
      "Packaged node-hid native-load check passed:",
      ...successes.map((line) => ` - ${line}`),
      ...skippedSection,
    ].join("\n"),
  };
}

const isMainModule = (() => {
  const invokedPath = process.argv[1];
  if (!invokedPath) {
    return false;
  }
  return NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(invokedPath);
})();

if (isMainModule) {
  // Strict mode via env (T3_REQUIRE_PACKAGED_NATIVE_CHECK) OR the
  // `--require-artifact` flag; either makes a missing host-arch artifact fail.
  const requireArtifact = process.argv.includes("--require-artifact") || isStrictModeFromEnv();
  const result = checkPackagedNodeHidLoad({ requireArtifact });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
