/**
 * Configuration parsing for the pi-harness extension.
 *
 * All settings are controlled via PI_HARNESS_* environment variables.
 * Every module has an independent enable flag so users can opt in/out
 * of individual techniques.
 */
import type { HarnessConfig } from "./types.js";

/** Parse a boolean env var, returning fallback when unset/empty. */
function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

/** Parse a positive integer env var, returning fallback when unset/invalid. */
function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Parse a shortcut env var with disable aliases. Returns undefined when disabled. */
function envShortcut(name: string, fallback: string): string | undefined {
	const value = process.env[name]?.trim();
	if (value === undefined || value === "") return fallback;
	return ["0", "false", "no", "off", "none", "disabled"].includes(
		value.toLowerCase(),
	)
		? undefined
		: value;
}

/** Parse a comma-separated list env var. */
function envList(name: string, fallback: string[]): string[] {
	const value = process.env[name]?.trim();
	if (!value) return fallback;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Parse an escalation strategy env var, returning fallback when unset/invalid. */
function envEscalation(name: string, fallback: "guard_then_abort" | "abort"): "guard_then_abort" | "abort" {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === "abort" || value === "guard_then_abort") return value;
	return fallback;
}

/**
 * Build the full HarnessConfig from environment variables.
 *
 * Env vars (all prefixed PI_HARNESS_):
 *   _ENABLED              master switch          (default: true)
 *   _MODEL_PATTERN        model patterns for gated modules (default: deepseek)
 *   _CACHE_ENABLED        cache module           (default: true)
 *   _CACHE_STRIP_REASONING strip reasoning       (default: true)
 *   _CACHE_SORT_TOOLS     sort tool schemas      (default: true)
 *   _CACHE_STRIP_TIMESTAMPS remove timestamps    (default: true)
 *   _HASHLINES_ENABLED    hashline editing       (default: true)
 *   _STORMBREAKER_ENABLED storm-breaker          (default: true)
 *   _STORMBREAKER_THRESHOLD consecutive failures (default: 3)
 *   _STORMBREAKER_ESCALATION "guard_then_abort" (inject guard first) or "abort" (default: guard_then_abort)
 *   _PLANMODE_ENABLED     plan mode              (default: true)
 *   _PLANMODE_SHORTCUT    toggle shortcut        (default: ctrl+shift+p)
 *   _PLANMODE_READONLY_TOOLS  read-only tools    (default: read,grep,find,ls)
 *   _REWIND_ENABLED       rewind                 (default: false)
 *   _REWIND_STRATEGY      snapshot strategy      (default: git)
 */
export function parseConfig(): HarnessConfig {
	return {
		enabled: envBool("PI_HARNESS_ENABLED", true),
		modelPattern: envList("PI_HARNESS_MODEL_PATTERN", ["deepseek"]),
		cache: {
			enabled: envBool("PI_HARNESS_CACHE_ENABLED", true),
			stripReasoning: envBool("PI_HARNESS_CACHE_STRIP_REASONING", true),
			sortTools: envBool("PI_HARNESS_CACHE_SORT_TOOLS", true),
			stripTimestamps: envBool("PI_HARNESS_CACHE_STRIP_TIMESTAMPS", true),
		},
		hashlines: {
			enabled: envBool("PI_HARNESS_HASHLINES_ENABLED", true),
		},
		stormbreaker: {
			enabled: envBool("PI_HARNESS_STORMBREAKER_ENABLED", true),
			threshold: envInt("PI_HARNESS_STORMBREAKER_THRESHOLD", 3),
			escalation: envEscalation("PI_HARNESS_STORMBREAKER_ESCALATION", "guard_then_abort"),
		},
		planmode: {
			enabled: envBool("PI_HARNESS_PLANMODE_ENABLED", true),
			shortcut: envShortcut("PI_HARNESS_PLANMODE_SHORTCUT", "ctrl+shift+p"),
			readonlyTools: envList("PI_HARNESS_PLANMODE_READONLY_TOOLS", [
				"read",
				"grep",
				"find",
				"ls",
			]),
		},
		rewind: {
			enabled: envBool("PI_HARNESS_REWIND_ENABLED", false),
			strategy: "git",
		},
	};
}