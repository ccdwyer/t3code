import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";

import {
  checkPackagedNodeHidLoad,
  findAppAsarUnpackedDirs,
  resolvePackagedNodeHidEntryUrl,
  resolveReleaseSearchRoots,
  runPackagedNodeHidLoadCheck,
} from "./packaged-native-load-check.mjs";

function makeTempDir() {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-micro-packaging-"));
}

/** Writes a minimal fake `node-hid` package into `unpackedDir/node_modules/node-hid`. */
function writeFakeNodeHid(unpackedDir, { devicesAsyncBody }) {
  const packageDir = NodePath.join(unpackedDir, "node_modules", "node-hid");
  NodeFS.mkdirSync(packageDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
    JSON.stringify({ name: "node-hid", version: "3.4.0", main: "nodehid.js" }),
  );
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "nodehid.js"),
    `export async function devicesAsync() {\n${devicesAsyncBody}\n}\n`,
  );
}

describe("resolveReleaseSearchRoots", () => {
  it("defaults to the release and release-mock output directories", () => {
    const roots = resolveReleaseSearchRoots({});
    assert.lengthOf(roots, 2);
    assert.isTrue(roots[0].endsWith(`${NodePath.sep}release`));
    assert.isTrue(roots[1].endsWith(`${NodePath.sep}release-mock`));
  });

  it("honors T3CODE_DESKTOP_RELEASE_DIR as a single override root", () => {
    const roots = resolveReleaseSearchRoots({ T3CODE_DESKTOP_RELEASE_DIR: "/tmp/custom-release" });
    assert.deepStrictEqual(roots, ["/tmp/custom-release"]);
  });
});

describe("findAppAsarUnpackedDirs", () => {
  it("finds every app.asar.unpacked directory without descending into them", () => {
    const root = makeTempDir();
    try {
      const arm64Unpacked = NodePath.join(
        root,
        "mac-arm64",
        "T3 Code.app",
        "Contents",
        "Resources",
        "app.asar.unpacked",
      );
      const x64Unpacked = NodePath.join(
        root,
        "mac-x64",
        "T3 Code.app",
        "Contents",
        "Resources",
        "app.asar.unpacked",
      );
      NodeFS.mkdirSync(NodePath.join(arm64Unpacked, "node_modules", "node-hid"), {
        recursive: true,
      });
      NodeFS.mkdirSync(NodePath.join(x64Unpacked, "node_modules", "node-hid"), {
        recursive: true,
      });
      // A stray nested app.asar.unpacked-looking dir inside the unpacked tree
      // must not be double-counted (walk should not descend past the match).
      NodeFS.mkdirSync(NodePath.join(arm64Unpacked, "node_modules", "app.asar.unpacked", "decoy"), {
        recursive: true,
      });

      const found = findAppAsarUnpackedDirs([root]);
      assert.sameMembers(found, [arm64Unpacked, x64Unpacked]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty array when no search roots exist", () => {
    const found = findAppAsarUnpackedDirs([NodePath.join(NodeOS.tmpdir(), "does-not-exist-xyz")]);
    assert.deepStrictEqual(found, []);
  });
});

describe("resolvePackagedNodeHidEntryUrl", () => {
  it("returns null when node-hid is absent from the unpacked tree", () => {
    const root = makeTempDir();
    try {
      assert.isNull(resolvePackagedNodeHidEntryUrl(root));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the package's main entry as a file:// URL", () => {
    const root = makeTempDir();
    try {
      writeFakeNodeHid(root, { devicesAsyncBody: "  return [];" });
      const entryUrl = resolvePackagedNodeHidEntryUrl(root);
      assert.isNotNull(entryUrl);
      assert.isTrue(entryUrl.startsWith("file://"));
      assert.isTrue(entryUrl.endsWith("nodehid.js"));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runPackagedNodeHidLoadCheck", () => {
  it("passes when devicesAsync exists and returns an array", () => {
    const root = makeTempDir();
    try {
      writeFakeNodeHid(root, { devicesAsyncBody: "  return [{ vendorId: 1, productId: 2 }];" });
      const entryUrl = resolvePackagedNodeHidEntryUrl(root);
      const result = runPackagedNodeHidLoadCheck(entryUrl);
      assert.equal(result.status, 0);
      assert.include(result.stdout, "node-hid packaged native load OK");
      assert.include(result.stdout, "1 device(s)");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when devicesAsync throws (simulated load failure)", () => {
    const root = makeTempDir();
    try {
      writeFakeNodeHid(root, {
        devicesAsyncBody: '  throw new Error("simulated native load failure");',
      });
      const entryUrl = resolvePackagedNodeHidEntryUrl(root);
      const result = runPackagedNodeHidLoadCheck(entryUrl);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "simulated native load failure");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when devicesAsync is missing entirely", () => {
    const root = makeTempDir();
    try {
      const packageDir = NodePath.join(root, "node_modules", "node-hid");
      NodeFS.mkdirSync(packageDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(packageDir, "package.json"),
        JSON.stringify({ name: "node-hid", version: "3.4.0", main: "nodehid.js" }),
      );
      NodeFS.writeFileSync(NodePath.join(packageDir, "nodehid.js"), "export default {};\n");
      const entryUrl = resolvePackagedNodeHidEntryUrl(root);
      const result = runPackagedNodeHidLoadCheck(entryUrl);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "devicesAsync is not a function");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkPackagedNodeHidLoad", () => {
  it("is skippable with a clear message when no packaged artifact exists", () => {
    const root = makeTempDir();
    try {
      const result = checkPackagedNodeHidLoad({
        env: { T3CODE_DESKTOP_RELEASE_DIR: NodePath.join(root, "release") },
      });
      assert.isFalse(result.ran);
      assert.isTrue(result.ok);
      assert.include(result.message, "skipping the packaged node-hid native-load check");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("actually runs and passes when a valid packaged artifact is present", () => {
    const root = makeTempDir();
    try {
      const unpackedDir = NodePath.join(root, "mac-arm64", "app.asar.unpacked");
      NodeFS.mkdirSync(unpackedDir, { recursive: true });
      writeFakeNodeHid(unpackedDir, { devicesAsyncBody: "  return [];" });

      const result = checkPackagedNodeHidLoad({ env: { T3CODE_DESKTOP_RELEASE_DIR: root } });
      assert.isTrue(result.ran);
      assert.isTrue(result.ok);
      assert.include(result.message, "passed");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly (non-zero) when an artifact exists but node-hid is missing from it", () => {
    const root = makeTempDir();
    try {
      const unpackedDir = NodePath.join(root, "mac-x64", "app.asar.unpacked");
      NodeFS.mkdirSync(unpackedDir, { recursive: true });
      // No node_modules/node-hid written — simulates an asarUnpack regression.

      const result = checkPackagedNodeHidLoad({ env: { T3CODE_DESKTOP_RELEASE_DIR: root } });
      assert.isTrue(result.ran);
      assert.isFalse(result.ok);
      assert.include(result.message, "FAILED");
      assert.include(result.message, "node-hid is missing from the unpacked node_modules");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
