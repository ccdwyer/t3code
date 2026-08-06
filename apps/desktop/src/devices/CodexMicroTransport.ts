import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

/**
 * HID transport abstraction for the Codex Micro pad.
 *
 * The state machine ({@link ./CodexMicroDevice.ts}) talks ONLY to this
 * interface so it can be driven against a fake in tests. The one real
 * implementation ({@link layerNodeHid}) is backed by `node-hid` and is
 * USB-only — BLE is keys-only in v1, so there is no BLE transport here.
 *
 * `node-hid` is a native module. It is lazy-`import()`ed inside the effects
 * below so that merely importing this file never crashes a build/host that
 * lacks the compiled binary; a missing/failed native module surfaces as a
 * {@link CodexMicroTransportUnavailableError} the device service can render as
 * a capability-style "native module unavailable" state instead of throwing at
 * import time.
 */

// ── Enumerated device shape ──────────────────────────────────────────

export interface CodexMicroHidDeviceInfo {
  readonly path: string | undefined;
  readonly vendorId: number;
  readonly productId: number;
  readonly product: string | undefined;
  readonly manufacturer: string | undefined;
  readonly serialNumber: string | undefined;
}

// ── Errors ───────────────────────────────────────────────────────────

/** The native `node-hid` module could not be loaded on this host. */
export class CodexMicroTransportUnavailableError extends Schema.TaggedErrorClass<CodexMicroTransportUnavailableError>()(
  "CodexMicroTransportUnavailableError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The node-hid native module is unavailable, so Codex Micro USB transport cannot be used.";
  }
}

/** A HID operation (list/open/write/close) failed. */
export class CodexMicroTransportError extends Schema.TaggedErrorClass<CodexMicroTransportError>()(
  "CodexMicroTransportError",
  {
    operation: Schema.Literals(["list", "open", "write", "close"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Codex Micro HID ${this.operation} operation failed.`;
  }
}

export const CodexMicroTransportFailure = Schema.Union([
  CodexMicroTransportUnavailableError,
  CodexMicroTransportError,
]);
export type CodexMicroTransportFailure = typeof CodexMicroTransportFailure.Type;
export const isCodexMicroTransportFailure = Schema.is(CodexMicroTransportFailure);

// ── Open connection handle ───────────────────────────────────────────

/**
 * An open connection to the device. Listener registration returns a plain
 * unsubscribe function (not an Effect) so the state machine can wire/unwire
 * callbacks synchronously while holding a Ref to the current connection.
 */
export interface CodexMicroConnection {
  /** Write a single output report (raw bytes incl. any leading report id). */
  readonly write: (report: ReadonlyArray<number>) => Effect.Effect<void, CodexMicroTransportError>;
  /** Close the underlying device handle. Never fails the caller. */
  readonly close: Effect.Effect<void>;
  /** Register a disconnect/hot-unplug listener. Returns an unsubscribe fn. */
  readonly onDisconnect: (listener: () => void) => () => void;
  /** Register an input-report listener. Returns an unsubscribe fn. */
  readonly onInputReport: (listener: (data: Uint8Array) => void) => () => void;
}

// ── Service tag ──────────────────────────────────────────────────────

export class CodexMicroTransport extends Context.Service<
  CodexMicroTransport,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<CodexMicroHidDeviceInfo>,
      CodexMicroTransportUnavailableError | CodexMicroTransportError
    >;
    readonly open: (
      device: CodexMicroHidDeviceInfo,
    ) => Effect.Effect<
      CodexMicroConnection,
      CodexMicroTransportUnavailableError | CodexMicroTransportError
    >;
  }
>()("@t3tools/desktop/devices/CodexMicroTransport") {}

// ── node-hid backed implementation ───────────────────────────────────

// Minimal structural view of the parts of `node-hid` we use; kept local so
// this file has no static import of the native module or its types.
interface NodeHidDevice {
  readonly path?: string | undefined;
  readonly vendorId: number;
  readonly productId: number;
  readonly product?: string | undefined;
  readonly manufacturer?: string | undefined;
  readonly serialNumber?: string | undefined;
}

interface NodeHidAsyncDevice {
  write(values: ReadonlyArray<number>): Promise<number>;
  close(): Promise<void>;
  on(event: "data", listener: (data: Buffer) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  removeListener(event: string, listener: (...args: Array<unknown>) => void): void;
}

interface NodeHidModule {
  devicesAsync(): Promise<ReadonlyArray<NodeHidDevice>>;
  HIDAsync: {
    open(path: string): Promise<NodeHidAsyncDevice>;
  };
}

/**
 * Lazy-load `node-hid` once and cache it. Any import/require failure (missing
 * prebuilt binary, ABI mismatch, unsupported platform) is mapped to
 * {@link CodexMicroTransportUnavailableError} rather than being thrown.
 */
const makeLazyNodeHid = Effect.gen(function* () {
  const cache = yield* Ref.make<NodeHidModule | null>(null);

  const load = Effect.gen(function* () {
    const cached = yield* Ref.get(cache);
    if (cached !== null) {
      return cached;
    }
    const loaded = yield* Effect.tryPromise({
      try: async () => {
        const mod = (await import("node-hid")) as unknown as
          | NodeHidModule
          | { default: NodeHidModule };
        return "default" in mod && mod.default ? mod.default : (mod as NodeHidModule);
      },
      catch: (cause) => new CodexMicroTransportUnavailableError({ cause }),
    });
    yield* Ref.set(cache, loaded);
    return loaded;
  });

  return load;
});

function makeNodeHidConnection(device: NodeHidAsyncDevice): CodexMicroConnection {
  return {
    write: (report) =>
      Effect.tryPromise({
        try: () => device.write([...report]),
        catch: (cause) => new CodexMicroTransportError({ operation: "write", cause }),
      }).pipe(Effect.asVoid),
    close: Effect.tryPromise({
      try: () => device.close(),
      // Closing a handle for an already-unplugged device routinely rejects; that
      // is not an actionable error for callers, so `close` stays non-failing.
      catch: (cause) => new CodexMicroTransportError({ operation: "close", cause }),
    }).pipe(
      // Keep close non-failing for callers, but surface the cause for
      // diagnostics instead of swallowing it silently.
      Effect.catchCause((cause) => Effect.logWarning("codex-micro transport close failed", cause)),
    ),
    onDisconnect: (listener) => {
      // node-hid signals hot-unplug / read failure through the "error" event.
      const handler = (_error: unknown): void => listener();
      device.on("error", handler);
      return () => device.removeListener("error", handler as (...args: Array<unknown>) => void);
    },
    onInputReport: (listener) => {
      const handler = (data: Buffer): void => listener(new Uint8Array(data));
      device.on("data", handler);
      return () => device.removeListener("data", handler as (...args: Array<unknown>) => void);
    },
  };
}

export const makeNodeHid = Effect.gen(function* () {
  const loadNodeHid = yield* makeLazyNodeHid;

  return CodexMicroTransport.of({
    list: Effect.gen(function* () {
      const nodeHid = yield* loadNodeHid;
      const devices = yield* Effect.tryPromise({
        try: () => nodeHid.devicesAsync(),
        catch: (cause) => new CodexMicroTransportError({ operation: "list", cause }),
      });
      return devices.map(
        (device): CodexMicroHidDeviceInfo => ({
          path: device.path,
          vendorId: device.vendorId,
          productId: device.productId,
          product: device.product,
          manufacturer: device.manufacturer,
          serialNumber: device.serialNumber,
        }),
      );
    }),
    open: (device) =>
      Effect.gen(function* () {
        const nodeHid = yield* loadNodeHid;
        if (device.path === undefined) {
          return yield* new CodexMicroTransportError({
            operation: "open",
            cause: new Error("Codex Micro device has no HID path to open."),
          });
        }
        const path = device.path;
        const handle = yield* Effect.tryPromise({
          try: () => nodeHid.HIDAsync.open(path),
          catch: (cause) => new CodexMicroTransportError({ operation: "open", cause }),
        });
        return makeNodeHidConnection(handle);
      }),
  });
});

export const layerNodeHid = Layer.effect(CodexMicroTransport, makeNodeHid);
