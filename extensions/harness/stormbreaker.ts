/**
 * Storm-breaker module — synthesized failure responses.
 *
 * Three responsibilities:
 *
 * 1. Enhance tool error messages via the `tool_result` event so the model gets
 *    actionable diagnostics instead of cryptic OS errors.
 *
 * 2. Detect consecutive identical tool failures and inject a guard message
 *    into the tool result (tier 1), giving the model a chance to self-correct.
 *    Only abort the loop (tier 2) if the same failure persists after the guard.
 *    Pattern from reasonix's applyStormBreaker: the model sees the guard as
 *    part of the tool output and can change approach.
 *
 * 3. Track blocked-turn streaks: consecutive turns where every tool call
 *    errored or was blocked. When the streak crosses the threshold, inject a
 *    different guard explaining that all tools are blocked.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "./types.js";
import type { FailureRecord } from "./types.js";
import { enhanceError, errorSignature, extractErrorText } from "./utils.js";

/**
 * Fired when a tool finishes executing (defined locally — not re-exported).
 */
interface LocalToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

/**
 * Storm-breaker runtime state (mutable, shared across event handlers).
 */
export interface StormBreakerState {
	/** Current consecutive failure tracking. */
	current: FailureRecord | null;
	/** Total loops broken (aborted after tier 2). */
	loopsBroken: number;
	/** Total errors enhanced. */
	errorsEnhanced: number;
	/** Pending abort signal: set by tool_result tier 2, consumed by tool_execution_end. */
	pendingAbort: { toolName: string; count: number; error: string } | null;
	/** Consecutive turns where every tool call errored/was blocked. */
	blockedTurnStreak: number;
	/** Whether any tool succeeded in the current turn (resets on turn_start). */
	turnHadSuccess: boolean;
	/** Whether any tool errored in the current turn (for all-blocked check). */
	turnHadError: boolean;
}

/**
 * Register storm-breaker hooks.
 *
 * @returns StormBreakerState (mutable) for display by commands.
 */
export function registerStormBreaker(
	pi: ExtensionAPI,
	config: HarnessConfig["stormbreaker"],
): StormBreakerState {
	const state: StormBreakerState = {
		current: null,
		loopsBroken: 0,
		errorsEnhanced: 0,
		pendingAbort: null,
		blockedTurnStreak: 0,
		turnHadSuccess: false,
		turnHadError: false,
	};

	if (!config.enabled) return state;

	const useEscalation = config.escalation === "guard_then_abort";

	// ── turn_start: finalize previous turn's blockedTurnStreak ─────────
	pi.on("turn_start", async (_event) => {
		if (state.turnHadError && !state.turnHadSuccess) {
			state.blockedTurnStreak++;
		} else if (state.turnHadSuccess) {
			state.blockedTurnStreak = 0;
		}
		state.turnHadSuccess = false;
		state.turnHadError = false;
		// Reset pending abort — new turn, clean slate.
		state.pendingAbort = null;
	});

	// ── Hook 1: Enhance tool error messages + guard injection ──────────
	//
	// The `tool_result` event fires after a tool executes. We can return
	// modified content that the model sees.
	//   - On isError: enhance the error message
	//   - On threshold reached (tier 1): inject a guard message into the
	//     tool result so the model knows to change approach
	//   - On threshold reached after guard (tier 2): set pendingAbort so
	//     tool_execution_end can abort the loop
	pi.on("tool_result", async (event: ToolResultEvent) => {
		const errorText = extractErrorText(event.content);

		if (!event.isError) {
			// Success — reset the failure tracker.
			state.current = null;
			return;
		}

		// Build a signature for dedup.
		const sig = errorSignature(event.toolName, errorText);

		const { thresholdReached, count } = updateFailureTracker(
			state,
			event.toolName,
			sig,
			event.toolCallId,
			config.threshold,
		);

		// Always enhance the error for better diagnostics.
		let resultText = errorText;
		if (errorText) {
			const enhanced = enhanceError(event.toolName, errorText);
			if (enhanced !== errorText) {
				state.errorsEnhanced++;
				resultText = enhanced;
			}
		}

		if (!thresholdReached) {
			// Below threshold — return enhanced error, model can self-correct.
			return {
				content: [{ type: "text" as const, text: resultText }],
			};
		}

		// ── Threshold reached ──────────────────────────────────────────
		const failure = state.current!;

		if (useEscalation && !failure.guarded) {
			// ── Tier 1: inject guard into tool result ──────────────────
			failure.guarded = true;

			const guardSubject = `\`${failure.toolName}\` failed ${count} times in a row`;
			const guard = [
				`\n\n[loop guard] ${guardSubject}. Re-sending it — even with the arguments reworded — will not help: the calls keep hitting the same host response.`,
				`Change approach: fix the arguments, use a different tool, or explain the blocker in your final answer.`,
				`Last error: ${resultText.slice(0, 300)}`,
			].join("\n");

			return {
				content: [
					{ type: "text" as const, text: resultText + guard },
				],
			};
		}

		// ── Tier 2: guard already injected, same failure persists ─────
		// Signal tool_execution_end to abort the loop.
		state.pendingAbort = {
			toolName: failure.toolName,
			count: failure.count,
			error: resultText.slice(0, 300),
		};

		// Still return the error content — the model sees it.
		return {
			content: [{ type: "text" as const, text: resultText }],
		};
	});

	// ── Hook 2: Act on pending abort + track blocked-turn streak ───────
	//
	// The `tool_execution_end` event fires after tool_result. We use it for:
	//   1. Executing pending abort (tier 2 escalation)
	//   2. Tracking turn-level success/error for blockedTurnStreak
	pi.on(
		"tool_execution_end",
		async (event: LocalToolExecutionEndEvent, ctx: ExtensionContext) => {
			// ── Track turn-level success/error for blockedTurnStreak ────
			if (event.isError) {
				state.turnHadError = true;
			} else {
				state.turnHadSuccess = true;
				state.current = null;
			}

			// ── Check for pending abort (tier 2 escalation) ────────────
			const abort = state.pendingAbort;
			if (!abort) return;

			state.pendingAbort = null;
			state.current = null;
			state.loopsBroken++;

			// ── blockedTurnStreak guard ──────────────────────────────
			// If the streak also hit threshold, use a different message.
			if (state.blockedTurnStreak >= config.threshold) {
				const message = [
					`Unable to continue: every tool call in the last ${state.blockedTurnStreak} turns has been blocked or failed.`,
					``,
					`Last tool: \`${abort.toolName}\` failed ${abort.count}x — ${abort.error}`,
					``,
					`Switching tools, reordering calls, or rewording arguments will not help while the blockers stand.`,
					`Change approach: respect the permission, plan-mode, hook, or loop-guard blocker; use an already-allowed tool, ask the user for approval, or explain the blocker.`,
				].join("\n");

				ctx.abort();
				pi.sendMessage(
					{
						customType: "harness_stormbreaker",
						content: message,
						display: true,
						details: {
							tool: abort.toolName,
							count: abort.count,
							streak: state.blockedTurnStreak,
							error: abort.error,
						},
					},
					{ triggerTurn: false },
				);

				ctx.ui.notify(
					`Storm-breaker: all tools blocked ${state.blockedTurnStreak} turns — loop broken`,
					"warning",
				);
				state.blockedTurnStreak = 0;
				return;
			}

			// ── Standard guard-injection-failed abort ──────────────────
			const message = [
				`Unable to continue: tool \`${abort.toolName}\` failed ${abort.count} times in a row after a loop-guard warning.`,
				``,
				`Last error: ${abort.error}`,
				``,
				`This usually means the arguments are wrong, or the target doesn't exist.`,
				`Please clarify what you'd like me to do, or check the inputs and try again.`,
			].join("\n");

			ctx.abort();
			pi.sendMessage(
				{
					customType: "harness_stormbreaker",
					content: message,
					display: true,
					details: {
						tool: abort.toolName,
						count: abort.count,
						error: abort.error,
					},
				},
				{ triggerTurn: false },
			);

			ctx.ui.notify(
				`Storm-breaker: ${abort.toolName} failed ${abort.count}x after guard — loop broken`,
				"warning",
			);
		},
	);

	return state;
}

/**
 * Extract the result text from a tool_execution_end event result.
 * Pure function extracted for testing.
 */
export function extractResultText(result: unknown): string {
	if (typeof result === "string") return result;
	const resultAny = result as Record<string, unknown> | undefined;
	if (!resultAny) return "";
	if (resultAny.content) {
		return extractErrorText(
			Array.isArray(resultAny.content)
				? (resultAny.content as { type: string; text?: string }[])
				: [{ type: "text", text: String(resultAny.content) }],
		);
	}
	if (resultAny.error) return String(resultAny.error);
	if (resultAny.message) return String(resultAny.message);
	return "";
}

/**
 * Pure function: update the consecutive failure tracker and return whether
 * the threshold has been reached.
 *
 * @returns object with thresholdReached flag and current count.
 */
export function updateFailureTracker(
	state: StormBreakerState,
	toolName: string,
	sig: string,
	toolCallId: string,
	threshold: number,
): { thresholdReached: boolean; count: number } {
	if (
		state.current &&
		state.current.toolName === toolName &&
		state.current.errorSignature === sig
	) {
		state.current.count++;
		state.current.lastToolCallId = toolCallId;
	} else {
		state.current = {
			toolName,
			errorSignature: sig,
			count: 1,
			lastToolCallId: toolCallId,
			guarded: false,
		};
	}

	const count = state.current.count;
	return { thresholdReached: count >= threshold, count };
}
