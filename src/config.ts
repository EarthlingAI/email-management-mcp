/**
 * Self-contained configuration for himalaya-mcp.
 *
 * Resolution chains (first match wins):
 *   Binary: HIMALAYA_BINARY env → local bin/himalaya[.exe] → "himalaya" (PATH)
 *   Config: HIMALAYA_CONFIG env → local config.toml → omit (himalaya default)
 *
 * On Windows, absolute paths passed to --config are converted to ~-relative
 * paths to work around himalaya's clap value_delimiter splitting on ':'.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HimalayaClientOptions } from "./himalaya/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Package root (one level up from src/) */
const PKG_ROOT = resolve(__dirname, "..");

const isWindows = process.platform === "win32";

/**
 * Convert an absolute Windows path to a ~-relative path.
 * himalaya's --config uses clap value_delimiter ':' which splits on
 * the colon in drive letters (C:\...). Using ~/relative avoids this.
 * himalaya's shellexpand crate resolves ~ via the dirs crate (%USERPROFILE%).
 */
function toTildePath(absPath: string): string {
	const home = process.env.USERPROFILE || process.env.HOME || "";
	if (!home) return absPath;
	const normalized = absPath.replace(/\\/g, "/");
	const normalizedHome = home.replace(/\\/g, "/");
	if (normalized.startsWith(normalizedHome)) {
		return "~" + normalized.slice(normalizedHome.length);
	}
	return absPath;
}

/** Return the value only if it's a real string (not an unresolved template variable). */
function resolvedEnv(key: string): string | undefined {
	const val = process.env[key];
	if (!val || val.startsWith("${")) return undefined;
	return val;
}

/** Resolve himalaya binary path. */
function resolveBinary(): string | undefined {
	// 1. Explicit env override
	const envBinary = resolvedEnv("HIMALAYA_BINARY");
	if (envBinary) return envBinary;

	// 2. Local bin/ directory
	const ext = isWindows ? ".exe" : "";
	const localBin = join(PKG_ROOT, "bin", `himalaya${ext}`);
	if (existsSync(localBin)) return localBin;

	// 3. Fall through to default ("himalaya" on PATH)
	return undefined;
}

/** Resolve himalaya config path. */
function resolveConfig(): string | undefined {
	// 1. Explicit env override
	const envConfig = resolvedEnv("HIMALAYA_CONFIG");
	if (envConfig) {
		return isWindows ? toTildePath(envConfig) : envConfig;
	}

	// 2. Local config.toml
	const localConfig = join(PKG_ROOT, "config.toml");
	if (existsSync(localConfig)) {
		return isWindows ? toTildePath(localConfig) : localConfig;
	}

	// 3. Omit — himalaya uses its own default (~/.config/himalaya/config.toml)
	return undefined;
}

export function loadConfig(): HimalayaClientOptions {
	const config: HimalayaClientOptions = {};

	const binary = resolveBinary();
	if (binary) config.binary = binary;

	const configPath = resolveConfig();
	if (configPath) config.configPath = configPath;

	const account = resolvedEnv("HIMALAYA_ACCOUNT");
	if (account) config.account = account;

	const folder = resolvedEnv("HIMALAYA_FOLDER");
	if (folder) config.folder = folder;

	const timeoutStr = resolvedEnv("HIMALAYA_TIMEOUT");
	if (timeoutStr) {
		const timeout = parseInt(timeoutStr, 10);
		if (!isNaN(timeout) && timeout >= 0) config.timeout = timeout;
	}

	return config;
}
