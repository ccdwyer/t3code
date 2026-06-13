// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
