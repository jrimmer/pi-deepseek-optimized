/**
 * Storm-breaker module — synthesized failure responses.
 *
 * Two responsibilities:
 *
 * 1. Enhance tool error messages via the `tool_result` event so the model gets
 *    actionable diagnostics instead of cryptic OS errors.
 *
 * 2. Detect consecutive identical tool failures via `tool_execution_end` and
 *    break the loop after a threshold, injecting a synthesized assistant-style
 *    message that explains what went wrong.
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
	/** Total loops broken. */
	loopsBroken: number;
	/** Total errors enhanced. */
	errorsEnhanced: number;
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
	};

	if (!config.enabled) return state;

	// ── Hook 1: Enhance tool error messages ─────────────────────────────
	//
	// The `tool_result` event fires after a tool executes. When isError is
	// true, we replace the content with an enhanced, actionable message.
	// This gives the model enough information to self-correct instead of
	// blindly retrying the same broken call.
	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (!event.isError) return;

		const errorText = extractErrorText(event.content);
		if (!errorText) return;

		const enhanced = enhanceError(event.toolName, errorText);
		if (enhanced === errorText) return; // no enhancement applicable

		state.errorsEnhanced++;

		// Return modified content — the model sees the enhanced error.
		return {
			content: [{ type: "text" as const, text: enhanced }],
		};
	});

	// ── Hook 2: Track consecutive failures and break the loop ──────────
	//
	// The `tool_execution_end` event fires with isError after each tool call.
	// We track consecutive identical failures (same tool + same error class)
	// and break the loop after the configured threshold.
	pi.on(
		"tool_execution_end",
		async (event: LocalToolExecutionEndEvent, ctx: ExtensionContext) => {
			if (!event.isError) {
				// Success — reset the failure tracker.
				state.current = null;
				return;
			}

			// Build a signature for dedup. The result may be an error object or
			// the raw content. We extract text from whatever we can.
			const resultText = extractResultText(event.result);

			const sig = errorSignature(event.toolName, resultText);

			const { thresholdReached } = updateFailureTracker(
				state,
				event.toolName,
				sig,
				event.toolCallId,
				config.threshold,
			);

			if (!thresholdReached) return;

			// ── Threshold reached — break the loop ──────────────────────────
			const failure = state.current!;
			state.current = null;
			state.loopsBroken++;

			// Abort the current agent operation to stop the loop.
			ctx.abort();

			// Inject a synthesized message explaining what happened.
			// Using sendMessage with a custom type lets us render it distinctly
			// in the TUI and optionally trigger a turn for the user to continue.
			const message = [
				`Unable to continue: tool \`${failure.toolName}\` failed ${failure.count} times in a row.`,
				``,
				`Last error: ${resultText.slice(0, 300) || "unknown error"}`,
				``,
				`This usually means the arguments are wrong, or the target doesn't exist.`,
				`Please clarify what you'd like me to do, or check the inputs and try again.`,
			].join("\n");

			pi.sendMessage(
				{
					customType: "harness_stormbreaker",
					content: message,
					display: message,
				} as any,
				{ triggerTurn: false },
			);

			// Surface to the user via notification.
			ctx.ui.notify(
				`Storm-breaker: ${failure.toolName} failed ${failure.count}x — loop broken`,
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
		};
	}

	const count = state.current.count;
	return { thresholdReached: count >= threshold, count };
}
