/**
 * pi-harness extension — closes the quality gap between DeepSeek V4 Pro
 * and Claude by implementing five harness techniques from the cwcode Substack
 * post (https://howardchen.substack.com/p/deepseek-v4-pro-at-5-the-cost-of):
 *
 * 1. Cache prefix stability — strip reasoning_content, sort tools, remove
 *    timestamps to maximize DeepSeek prompt cache hit ratio (~120x cost
 *    difference between cache hit and miss).
 *
 * 2. Storm-breaker — enhance tool error messages with actionable diagnostics
 *    and break consecutive-failure loops with synthesized messages.
 *
 * 3. Hashline editing — hash-annotate read output + register edit_lines tool
 *    for hash-verified line-range edits (avoids exact-string reproduction).
 *
 * 4. Plan mode — dynamically restrict to read-only tools via a keyboard
 *    shortcut so the model produces a plan instead of making changes.
 *
 * 5. Rewind — git-stash-based file snapshots before each turn, restorable
 *    via /rewind N command.
 *
 * All features are independently configurable via PI_HARNESS_* env vars.
 * Run /deepseek-optimized to see current status and stats.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseConfig } from "./harness/config.js";
import { registerCacheHooks, type CacheStats } from "./harness/cache.js";
import {
	registerStormBreaker,
	type StormBreakerState,
} from "./harness/stormbreaker.js";
import { registerHashlines, type HashlineStats } from "./harness/hashlines.js";
import { registerPlanMode, type PlanModeState } from "./harness/planmode.js";
import { registerRewind, type RewindState } from "./harness/rewind.js";
import type { HarnessConfig } from "./harness/types.js";
import { matchesModelPattern } from "./harness/utils.js";

export type { HarnessConfig } from "./harness/types.js";
export type { CacheStats } from "./harness/cache.js";
export type { StormBreakerState } from "./harness/stormbreaker.js";
export type { HashlineStats } from "./harness/hashlines.js";
export type { PlanModeState } from "./harness/planmode.js";
export type { RewindState } from "./harness/rewind.js";
export type { HashEdit } from "./harness/types.js";
export type { FailureRecord } from "./harness/types.js";

// Re-export pure utilities for testing
export {
	lineHash,
	annotateLine,
	annotateContent,
	isAnnotated,
	enhanceError,
	errorSignature,
	extractErrorText,
	matchesModelPattern,
} from "./harness/utils.js";
export { parseConfig } from "./harness/config.js";
export { TIMESTAMP_RE, stripTimestampsFromPrompt } from "./harness/cache.js";
export {
	extractResultText,
	updateFailureTracker,
} from "./harness/stormbreaker.js";
export {
	validateEdits,
	applyEditsToLines,
	buildEditSummary,
	editLinesSchema,
	detectConfusedEditArgs,
} from "./harness/hashlines.js";
export { buildPlanDirective } from "./harness/planmode.js";

export default function harnessPlugin(pi: ExtensionAPI): void {
	const config = parseConfig();

	if (!config.enabled) return;

	// ── Register all modules ────────────────────────────────────────────
	const cacheStats = registerCacheHooks(pi, config.cache, config.modelPattern);
	const stormbreakerState = registerStormBreaker(pi, config.stormbreaker);
	const hashlineStats = registerHashlines(
		pi,
		config.hashlines,
		"",
		config.modelPattern,
	);
	const planModeState = registerPlanMode(pi, config.planmode);
	const rewindState = registerRewind(pi, config.rewind);

	// ── Footer status indicator ───────────────────────────────────────────
	//
	// When a model matching the pattern is active and at least one gated
	// module (cache or hashlines) is enabled, show “⚡ Optimized” in the
	// footer. Clears on non-matching models so it’s invisible on Claude/GPT.
	const gatedActive = config.cache.enabled || config.hashlines.enabled;

	function updateFooterStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (gatedActive && matchesModelPattern(ctx.model, config.modelPattern)) {
			ctx.ui.setStatus("harness", "⚡Optimized");
		} else {
			ctx.ui.setStatus("harness", undefined);
		}
	}

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		updateFooterStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx: ExtensionContext) => {
		updateFooterStatus(ctx);
	});

	// ── /deepseek-optimized command — status overview ───────────────────
	pi.registerCommand("deepseek-optimized", {
		description:
			"Show pi-deepseek-optimized status: active modules, stats, and configuration. Use /deepseek-optimized-plan to toggle plan mode.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines: string[] = ["pi-deepseek-optimized status:", ""];

			// Module status
			lines.push("Modules:");
			lines.push(
				`  cache         ${config.cache.enabled ? "ON" : "OFF"}  — reasoning stripped: ${cacheStats.reasoningStripped}, preserved (tool calls): ${cacheStats.reasoningPreserved}, tools sorted: ${cacheStats.toolsSorted}, timestamps stripped: ${cacheStats.timestampsStripped}`,
			);
			lines.push(
				`  stormbreaker  ${config.stormbreaker.enabled ? "ON" : "OFF"}  — errors enhanced: ${stormbreakerState.errorsEnhanced}, loops broken: ${stormbreakerState.loopsBroken} (threshold: ${config.stormbreaker.threshold})`,
			);
			lines.push(
				`  hashlines     ${config.hashlines.enabled ? "ON" : "OFF"}  — reads annotated: ${hashlineStats.readsAnnotated}, edit calls: ${hashlineStats.editCalls}, mismatches: ${hashlineStats.hashMismatches}, successes: ${hashlineStats.editSuccesses}`,
			);
			lines.push(
				`  plan mode     ${config.planmode.enabled ? "ON" : "OFF"}  — active: ${planModeState.active}, toggles: ${planModeState.toggleCount}${config.planmode.shortcut ? `, shortcut: ${config.planmode.shortcut}` : ""}`,
			);
			lines.push(
				`  rewind        ${config.rewind.enabled ? "ON" : "OFF"}  — checkpoints: ${rewindState.totalCheckpoints}, rewinds: ${rewindState.totalRewinds}, in repo: ${rewindState.insideRepo}`,
			);

			lines.push("", "Configuration (env vars):");
			lines.push(`  PI_HARNESS_ENABLED=${config.enabled}`);
			lines.push(`  PI_HARNESS_MODEL_PATTERN=${config.modelPattern.join(",")}`);
			lines.push(`  PI_HARNESS_CACHE_ENABLED=${config.cache.enabled}`);
			lines.push(
				`  PI_HARNESS_CACHE_STRIP_REASONING=${config.cache.stripReasoning}`,
			);
			lines.push(`  PI_HARNESS_CACHE_SORT_TOOLS=${config.cache.sortTools}`);
			lines.push(
				`  PI_HARNESS_CACHE_STRIP_TIMESTAMPS=${config.cache.stripTimestamps}`,
			);
			lines.push(`  PI_HARNESS_HASHLINES_ENABLED=${config.hashlines.enabled}`);
			lines.push(
				`  PI_HARNESS_STORMBREAKER_ENABLED=${config.stormbreaker.enabled}`,
			);
			lines.push(
				`  PI_HARNESS_STORMBREAKER_THRESHOLD=${config.stormbreaker.threshold}`,
			);
			lines.push(`  PI_HARNESS_PLANMODE_ENABLED=${config.planmode.enabled}`);
			lines.push(`  PI_HARNESS_REWIND_ENABLED=${config.rewind.enabled}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── /deepseek-optimized-plan command — toggle plan mode ────────────────
	if (config.planmode.enabled) {
		pi.registerCommand("deepseek-optimized-plan", {
			description:
				"Toggle plan mode (restrict to read-only tools for planning)",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const toggle = (
					planModeState as PlanModeState & {
						toggle: (ctx: ExtensionCommandContext) => Promise<void>;
					}
				).toggle;
				if (toggle) {
					await toggle(ctx);
				} else {
					ctx.ui.notify("Plan mode toggle not available", "warning");
				}
			},
		});
	}

	// ── Register storm-breaker message renderer ─────────────────────────
	// Render the synthesized failure message as an assistant-style message.
	if (config.stormbreaker.enabled) {
		pi.registerMessageRenderer(
			"harness_stormbreaker",
			(message, _options, _theme) => {
				// The display text is pre-formatted; we just return it as a component.
				// In interactive mode, the CustomMessageComponent handles rendering.
				// Returning undefined lets the default renderer handle it.
				return undefined;
			},
		);
	}
}
