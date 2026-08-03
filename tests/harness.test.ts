import { afterEach, describe, expect, it } from "vitest";
import {
	lineHash,
	annotateLine,
	annotateContent,
	isAnnotated,
	enhanceError,
	errorSignature,
	extractErrorText,
	matchesModelPattern,
	TIMESTAMP_RE,
	stripTimestampsFromPrompt,
	extractResultText,
	updateFailureTracker,
	validateEdits,
	applyEditsToLines,
	buildEditSummary,
	editLinesSchema,
	detectConfusedEditArgs,
	buildPlanDirective,
} from "../extensions/harness.js";
import { parseConfig } from "../extensions/harness/config.js";

// ─────────────────────────────────────────────────────────────────────────
// P0-1 contract: surgical reasoning_content strip/preserve
// ─────────────────────────────────────────────────────────────────────────
// Extracted as a pure function for testing. This mirrors the cache.ts context
// hook logic but with the P0-1 fix: reasoning_content MUST be preserved on
// assistant messages that carry tool_calls (DeepSeek contract), and MUST be
// stripped from plain assistant/tool messages (cache prefix stability).
// Pattern matches reasonix's:
//   TestBuildRequestDropsReasoningOnPlainAssistantTurn
//   TestBuildRequestRoundTripsReasoningOnDeepSeekToolCalls

/** Message shape as seen by the cache.ts context hook. */
interface ContextMessage {
	role: string;
	content?: unknown;
	reasoning_content?: string;
	reasoning?: string;
	tool_calls?: unknown[];
}

/**
 * Strip reasoning fields from context messages surgically:
 * - Plain assistant (no tool_calls) → strip
 * - Assistant with tool_calls → PRESERVE (DeepSeek requires round-trip)
 * - Tool messages → strip
 * - User messages → no-op
 *
 * Returns count of fields stripped.
 */
function stripReasoningSurgical(messages: ContextMessage[]): number {
	let stripped = 0;
	for (const msg of messages) {
		if (msg.role === "assistant") {
			const hasToolCalls =
				Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
			if (hasToolCalls) continue; // preserve for DeepSeek round-trip
			if ("reasoning_content" in msg) {
				delete msg.reasoning_content;
				stripped++;
			}
			if ("reasoning" in msg) {
				delete msg.reasoning;
				stripped++;
			}
		} else if (msg.role === "tool") {
			if ("reasoning_content" in msg) {
				delete msg.reasoning_content;
				stripped++;
			}
			if ("reasoning" in msg) {
				delete msg.reasoning;
				stripped++;
			}
		}
	}
	return stripped;
}

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

// ─────────────────────────────────────────────────────────────────────────
// lineHash
// ─────────────────────────────────────────────────────────────────────────

describe("lineHash", () => {
	it("returns a 3-char hex string", () => {
		const hash = lineHash("package tools");
		expect(hash).toMatch(/^[0-9a-f]{3}$/);
	});

	it("is deterministic for the same input", () => {
		expect(lineHash("import os")).toBe(lineHash("import os"));
	});

	it("differs for different content", () => {
		expect(lineHash("import os")).not.toBe(lineHash("import sys"));
	});

	it("ignores trailing whitespace", () => {
		expect(lineHash("hello   ")).toBe(lineHash("hello"));
		expect(lineHash("hello\t")).toBe(lineHash("hello"));
	});

	it("is consistent with empty string", () => {
		expect(lineHash("")).toMatch(/^[0-9a-f]{3}$/);
		expect(lineHash("")).toBe(lineHash(""));
	});
});

// ─────────────────────────────────────────────────────────────────────────
// annotateLine
// ─────────────────────────────────────────────────────────────────────────

describe("annotateLine", () => {
	it("formats with line number, hash, and arrow separator", () => {
		const result = annotateLine(1, "package tools");
		// Format: "     1:HHH→package tools"
		expect(result).toMatch(/^\s+1:[0-9a-f]{3}\u2192package tools$/);
	});

	it("uses the hash from lineHash", () => {
		const content = 'import "os"';
		const result = annotateLine(3, content);
		const hash = lineHash(content);
		expect(result).toContain(`:${hash}\u2192`);
	});

	it("preserves content after the arrow", () => {
		const content = "  const x = 42;  // comment";
		const result = annotateLine(10, content);
		expect(result.endsWith(content)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// isAnnotated
// ─────────────────────────────────────────────────────────────────────────

describe("isAnnotated", () => {
	it("detects annotated lines", () => {
		expect(isAnnotated("     1:5c2→hello")).toBe(true);
		expect(isAnnotated("   100:abc→world")).toBe(true);
	});

	it("rejects non-annotated lines", () => {
		expect(isAnnotated("hello world")).toBe(false);
		expect(isAnnotated("    1 hello")).toBe(false);
		expect(isAnnotated("")).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// annotateContent
// ─────────────────────────────────────────────────────────────────────────

describe("annotateContent", () => {
	it("annotates each line with sequential line numbers starting from 1", () => {
		const content = 'package tools\n\nimport "os"';
		const result = annotateContent(content, 1);
		const lines = result.split("\n");

		expect(lines[0]).toMatch(/^\s+1:[0-9a-f]{3}\u2192package tools$/);
		expect(lines[1]).toMatch(/^\s+2:[0-9a-f]{3}\u2192$/);
		expect(lines[2]).toMatch(/^\s+3:[0-9a-f]{3}\u2192import "os"$/);
	});

	it("respects the startLine offset", () => {
		const content = 'import "fmt"';
		const result = annotateContent(content, 51);
		expect(result).toMatch(/^\s+51:[0-9a-f]{3}\u2192import "fmt"$/);
	});

	it("does not double-annotate already-annotated lines", () => {
		const content = "     1:5c2\u2192hello\nworld";
		const result = annotateContent(content, 1);
		const lines = result.split("\n");
		// First line should be unchanged
		expect(lines[0]).toBe("     1:5c2\u2192hello");
		// Second line should be annotated with line number 2
		expect(lines[1]).toMatch(/^\s+2:[0-9a-f]{3}\u2192world$/);
	});

	it("leaves truncation notices un-annotated and skips blank separator", () => {
		const content =
			"line1\n\n[Showing lines 1-50 of 200. Use offset=51 to continue.]";
		const result = annotateContent(content, 1);
		const lines = result.split("\n");

		expect(lines[0]).toMatch(/^\s+1:[0-9a-f]{3}\u2192line1$/);
		// The blank separator before the notice is a display artifact, not a
		// real file line — it should NOT be annotated with a line number.
		expect(lines[1]).toBe("");
		// The notice line should NOT be annotated
		expect(lines[2]).toBe(
			"[Showing lines 1-50 of 200. Use offset=51 to continue.]",
		);
	});

	it("handles empty content", () => {
		const result = annotateContent("", 1);
		expect(result).toMatch(/^\s+1:[0-9a-f]{3}\u2192$/);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// extractErrorText
// ─────────────────────────────────────────────────────────────────────────

describe("extractErrorText", () => {
	it("extracts text from text content blocks", () => {
		const content = [
			{ type: "text", text: "Error: file not found" },
			{ type: "text", text: "Additional context" },
		];
		expect(extractErrorText(content)).toBe(
			"Error: file not found\nAdditional context",
		);
	});

	it("ignores image content", () => {
		const content = [
			{ type: "text", text: "Error" },
			{ type: "image", data: "base64...", mimeType: "image/png" },
		];
		expect(extractErrorText(content)).toBe("Error");
	});

	it("caps at 500 characters", () => {
		const longText = "x".repeat(600);
		const content = [{ type: "text", text: longText }];
		expect(extractErrorText(content).length).toBe(500);
	});

	it("handles empty content", () => {
		expect(extractErrorText([])).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// errorSignature
// ─────────────────────────────────────────────────────────────────────────

describe("errorSignature", () => {
	it("includes the tool name", () => {
		const sig = errorSignature("read", "some error");
		expect(sig.startsWith("read:")).toBe(true);
	});

	it("normalizes file paths to <path>", () => {
		const sig1 = errorSignature("read", "open /foo/bar.txt: no such file");
		const sig2 = errorSignature("read", "open /baz/qux.txt: no such file");
		expect(sig1).toBe(sig2);
	});

	it("normalizes line numbers", () => {
		const sig1 = errorSignature("edit", "Error at line 42: mismatch");
		const sig2 = errorSignature("edit", "Error at line 100: mismatch");
		expect(sig1).toBe(sig2);
	});

	it("produces different signatures for different error types", () => {
		const sig1 = errorSignature("read", "permission denied");
		const sig2 = errorSignature("read", "file not found");
		expect(sig1).not.toBe(sig2);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// enhanceError
// ─────────────────────────────────────────────────────────────────────────

describe("enhanceError", () => {
	it("enhances empty-path errors", () => {
		const result = enhanceError("read", "open : no such file or directory");
		expect(result).toContain("path");
		expect(result).toContain("empty or missing");
	});

	it("enhances permission errors with guidance", () => {
		const result = enhanceError("read", "permission denied");
		expect(result).toContain("not readable");
	});

	it("enhances edit not-found errors with retry guidance", () => {
		const result = enhanceError(
			"edit",
			"old_text did not match anything in the file",
		);
		expect(result).toContain("re-read");
	});

	it("enhances offset out-of-bounds errors", () => {
		const result = enhanceError(
			"read",
			"offset 500 is beyond end of file (100 lines total)",
		);
		expect(result).toContain("shorter than expected");
	});

	it("passes through unrecognised errors with tool name prefix", () => {
		const result = enhanceError("bash", "command not found: weirdcmd");
		expect(result).toContain("[bash]");
		expect(result).toContain("command not found: weirdcmd");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// matchesModelPattern
// ─────────────────────────────────────────────────────────────────────────

describe("matchesModelPattern", () => {
	it("matches by provider", () => {
		const model = {
			id: "v4-pro",
			provider: "deepseek",
			name: "DeepSeek V4 Pro",
		};
		expect(matchesModelPattern(model, ["deepseek"])).toBe(true);
	});

	it("matches by id", () => {
		const model = {
			id: "deepseek-v4-pro",
			provider: "openrouter",
			name: "V4 Pro",
		};
		expect(matchesModelPattern(model, ["deepseek"])).toBe(true);
	});

	it("matches by name", () => {
		const model = {
			id: "gpt-5",
			provider: "openai",
			name: "DeepSeek V4 Pro (proxy)",
		};
		expect(matchesModelPattern(model, ["deepseek"])).toBe(true);
	});

	it("is case-insensitive", () => {
		const model = {
			id: "v4-pro",
			provider: "DeepSeek",
			name: "DeepSeek V4 Pro",
		};
		expect(matchesModelPattern(model, ["deepseek"])).toBe(true);
	});

	it("matches any pattern in the list", () => {
		const model = { id: "kimi-k2", provider: "kimi-coding", name: "Kimi K2" };
		expect(matchesModelPattern(model, ["deepseek", "kimi"])).toBe(true);
	});

	it("returns false for non-matching models", () => {
		const model = {
			id: "claude-sonnet-4",
			provider: "anthropic",
			name: "Claude Sonnet 4",
		};
		expect(matchesModelPattern(model, ["deepseek"])).toBe(false);
	});

	it("returns false for undefined model", () => {
		expect(matchesModelPattern(undefined, ["deepseek"])).toBe(false);
	});

	it("returns false for empty patterns", () => {
		const model = {
			id: "deepseek-v4-pro",
			provider: "deepseek",
			name: "DeepSeek V4 Pro",
		};
		expect(matchesModelPattern(model, [])).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// parseConfig
// ─────────────────────────────────────────────────────────────────────────

describe("parseConfig", () => {
	it("returns defaults when no env vars are set", () => {
		// Clear all harness env vars
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_HARNESS_")) delete process.env[key];
		}
		const config = parseConfig();
		expect(config.enabled).toBe(true);
		expect(config.modelPattern).toEqual(["deepseek"]);
		expect(config.cache.enabled).toBe(true);
		expect(config.cache.stripReasoning).toBe(true);
		expect(config.cache.sortTools).toBe(true);
		expect(config.cache.stripTimestamps).toBe(true);
		expect(config.hashlines.enabled).toBe(true);
		expect(config.stormbreaker.enabled).toBe(true);
		expect(config.stormbreaker.threshold).toBe(3);
		expect(config.planmode.enabled).toBe(true);
		expect(config.planmode.shortcut).toBe("ctrl+shift+p");
		expect(config.planmode.readonlyTools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
		expect(config.rewind.enabled).toBe(false);
		expect(config.rewind.strategy).toBe("git");
	});

	it("respects PI_HARNESS_ENABLED=false", () => {
		process.env.PI_HARNESS_ENABLED = "false";
		const config = parseConfig();
		expect(config.enabled).toBe(false);
	});

	it("respects individual module disable flags", () => {
		process.env.PI_HARNESS_CACHE_ENABLED = "0";
		process.env.PI_HARNESS_HASHLINES_ENABLED = "no";
		process.env.PI_HARNESS_STORMBREAKER_ENABLED = "off";
		process.env.PI_HARNESS_PLANMODE_ENABLED = "false";
		process.env.PI_HARNESS_REWIND_ENABLED = "0";

		const config = parseConfig();
		expect(config.cache.enabled).toBe(false);
		expect(config.hashlines.enabled).toBe(false);
		expect(config.stormbreaker.enabled).toBe(false);
		expect(config.planmode.enabled).toBe(false);
		expect(config.rewind.enabled).toBe(false);
	});

	it("respects storm-breaker threshold", () => {
		process.env.PI_HARNESS_STORMBREAKER_THRESHOLD = "5";
		const config = parseConfig();
		expect(config.stormbreaker.threshold).toBe(5);
	});

	it("respects plan mode shortcut override", () => {
		process.env.PI_HARNESS_PLANMODE_SHORTCUT = "alt+p";
		const config = parseConfig();
		expect(config.planmode.shortcut).toBe("alt+p");
	});

	it("disables plan mode shortcut with off/disabled/none", () => {
		for (const val of ["off", "disabled", "none", "0", "false"]) {
			process.env.PI_HARNESS_PLANMODE_SHORTCUT = val;
			expect(parseConfig().planmode.shortcut).toBeUndefined();
		}
	});

	it("respects custom readonly tools list", () => {
		process.env.PI_HARNESS_PLANMODE_READONLY_TOOLS = "read,grep,bash";
		const config = parseConfig();
		expect(config.planmode.readonlyTools).toEqual(["read", "grep", "bash"]);
	});

	it("respects individual cache sub-flags", () => {
		process.env.PI_HARNESS_CACHE_STRIP_REASONING = "0";
		process.env.PI_HARNESS_CACHE_SORT_TOOLS = "false";
		process.env.PI_HARNESS_CACHE_STRIP_TIMESTAMPS = "no";
		const config = parseConfig();
		expect(config.cache.stripReasoning).toBe(false);
		expect(config.cache.sortTools).toBe(false);
		expect(config.cache.stripTimestamps).toBe(false);
	});

	it("respects custom model pattern", () => {
		process.env.PI_HARNESS_MODEL_PATTERN = "deepseek,kimi";
		const config = parseConfig();
		expect(config.modelPattern).toEqual(["deepseek", "kimi"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// TIMESTAMP_RE / stripTimestampsFromPrompt
// ─────────────────────────────────────────────────────────────────────────

describe("TIMESTAMP_RE", () => {
	afterEach(() => {
		TIMESTAMP_RE.lastIndex = 0;
	});

	it("matches current date/time lines", () => {
		expect(TIMESTAMP_RE.test("Current date is: 2026-03-21")).toBe(true);
		TIMESTAMP_RE.lastIndex = 0;
		expect(TIMESTAMP_RE.test("Current time is: 14:30:00")).toBe(true);
	});

	it("matches today is lines", () => {
		expect(TIMESTAMP_RE.test("Today is: Monday, March 21")).toBe(true);
	});

	it("matches date: and time: prefix lines", () => {
		expect(TIMESTAMP_RE.test("Date: 2026-03-21")).toBe(true);
		TIMESTAMP_RE.lastIndex = 0;
		expect(TIMESTAMP_RE.test("Time: 14:30")).toBe(true);
	});

	it("does not match ordinary sentences", () => {
		expect(TIMESTAMP_RE.test("The current status is: active")).toBe(false);
		TIMESTAMP_RE.lastIndex = 0;
		expect(TIMESTAMP_RE.test("The date format is YYYY-MM-DD")).toBe(false);
	});
});

describe("stripTimestampsFromPrompt", () => {
	it("strips timestamp lines from the prompt", () => {
		const prompt = [
			"You are a helpful coding agent.",
			"Current date is: 2026-03-21",
			"Today is: Monday",
			"Be careful when editing files.",
		].join("\n");
		const cleaned = stripTimestampsFromPrompt(prompt);
		expect(cleaned).not.toContain("Current date is:");
		expect(cleaned).not.toContain("Today is:");
		expect(cleaned).toContain("You are a helpful coding agent.");
		expect(cleaned).toContain("Be careful when editing files.");
	});

	it("returns the prompt unchanged when no timestamps match", () => {
		const prompt = "Hello world\nHow are you?";
		expect(stripTimestampsFromPrompt(prompt)).toBe(prompt);
	});

	it("collapses triple newlines to double newlines", () => {
		const prompt = "line1\n\nCurrent time is: 14:30\n\n\nline2";
		const cleaned = stripTimestampsFromPrompt(prompt);
		expect(cleaned).not.toContain("\n\n\n");
	});

	it("handles empty prompt", () => {
		expect(stripTimestampsFromPrompt("")).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// extractResultText
// ─────────────────────────────────────────────────────────────────────────

describe("extractResultText", () => {
	it("returns a string result as-is", () => {
		expect(extractResultText("error on line 42")).toBe("error on line 42");
	});

	it("extracts text from object with content array", () => {
		const result = {
			content: [{ type: "text", text: "Error: file not found" }],
		};
		expect(extractResultText(result)).toBe("Error: file not found");
	});

	it("extracts text from object with error field", () => {
		const result = { error: "permission denied" };
		expect(extractResultText(result)).toBe("permission denied");
	});

	it("extracts text from object with message field", () => {
		const result = { message: "something went wrong" };
		expect(extractResultText(result)).toBe("something went wrong");
	});

	it("returns empty string for empty object", () => {
		expect(extractResultText({})).toBe("");
	});

	it("returns empty string for undefined", () => {
		expect(extractResultText(undefined)).toBe("");
	});

	it("returns empty string for null", () => {
		expect(extractResultText(null)).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// updateFailureTracker
// ─────────────────────────────────────────────────────────────────────────

describe("updateFailureTracker", () => {
	it("starts tracking a new failure", () => {
		const state: {
			current: {
				toolName: string;
				errorSignature: string;
				count: number;
				lastToolCallId: string;
			} | null;
			loopsBroken: number;
			errorsEnhanced: number;
		} = { current: null, loopsBroken: 0, errorsEnhanced: 0 };
		const result = updateFailureTracker(
			state,
			"read",
			"read:not found",
			"call-1",
			3,
		);
		expect(result.count).toBe(1);
		expect(result.thresholdReached).toBe(false);
		expect(state.current!.toolName).toBe("read");
	});

	it("increments consecutive identical failures", () => {
		const state: {
			current: {
				toolName: string;
				errorSignature: string;
				count: number;
				lastToolCallId: string;
			} | null;
			loopsBroken: number;
			errorsEnhanced: number;
		} = { current: null, loopsBroken: 0, errorsEnhanced: 0 };
		updateFailureTracker(state, "read", "read:not found", "call-1", 3);
		const result = updateFailureTracker(
			state,
			"read",
			"read:not found",
			"call-2",
			3,
		);
		expect(result.count).toBe(2);
		expect(result.thresholdReached).toBe(false);
	});

	it("signals threshold reached", () => {
		const state: {
			current: {
				toolName: string;
				errorSignature: string;
				count: number;
				lastToolCallId: string;
			} | null;
			loopsBroken: number;
			errorsEnhanced: number;
		} = { current: null, loopsBroken: 0, errorsEnhanced: 0 };
		updateFailureTracker(state, "read", "read:not found", "call-1", 3);
		updateFailureTracker(state, "read", "read:not found", "call-2", 3);
		const result = updateFailureTracker(
			state,
			"read",
			"read:not found",
			"call-3",
			3,
		);
		expect(result.count).toBe(3);
		expect(result.thresholdReached).toBe(true);
	});

	it("resets on different tool name", () => {
		const state: {
			current: {
				toolName: string;
				errorSignature: string;
				count: number;
				lastToolCallId: string;
			} | null;
			loopsBroken: number;
			errorsEnhanced: number;
		} = { current: null, loopsBroken: 0, errorsEnhanced: 0 };
		updateFailureTracker(state, "read", "read:not found", "call-1", 3);
		const result = updateFailureTracker(
			state,
			"edit",
			"edit:not found",
			"call-2",
			3,
		);
		expect(result.count).toBe(1);
		expect(state.current!.toolName).toBe("edit");
	});

	it("resets on different error signature", () => {
		const state: {
			current: {
				toolName: string;
				errorSignature: string;
				count: number;
				lastToolCallId: string;
			} | null;
			loopsBroken: number;
			errorsEnhanced: number;
		} = { current: null, loopsBroken: 0, errorsEnhanced: 0 };
		updateFailureTracker(state, "read", "read:not found", "call-1", 3);
		const result = updateFailureTracker(
			state,
			"read",
			"read:permission denied",
			"call-2",
			3,
		);
		expect(result.count).toBe(1);
		expect(state.current!.errorSignature).toBe("read:permission denied");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// validateEdits
// ─────────────────────────────────────────────────────────────────────────

describe("validateEdits", () => {
	it("passes valid edits", () => {
		const lines = ["line1", "line2", "line3", "line4"];
		const edits = [
			{
				from: 2,
				from_hash: lineHash("line2"),
				to: 3,
				to_hash: lineHash("line3"),
				new_text: "new line",
			},
		];
		expect(validateEdits(lines, edits)).toBeNull();
	});

	it("passes single-line edits (from === to)", () => {
		const lines = ["line1", "line2", "line3"];
		const edits = [
			{
				from: 2,
				from_hash: lineHash("line2"),
				to: 2,
				to_hash: lineHash("line2"),
				new_text: "replaced",
			},
		];
		expect(validateEdits(lines, edits)).toBeNull();
	});

	it("rejects out-of-range from", () => {
		const lines = ["line1"];
		const edits = [
			{ from: 5, from_hash: "abc", to: 5, to_hash: "abc", new_text: "x" },
		];
		expect(validateEdits(lines, edits)).toContain("out of range");
	});

	it("rejects out-of-range to", () => {
		const lines = ["line1", "line2"];
		const edits = [
			{
				from: 1,
				from_hash: lineHash("line1"),
				to: 10,
				to_hash: "abc",
				new_text: "x",
			},
		];
		expect(validateEdits(lines, edits)).toContain("out of range");
	});

	it("rejects to before from", () => {
		const lines = ["line1", "line2", "line3"];
		const edits = [
			{
				from: 3,
				from_hash: lineHash("line3"),
				to: 1,
				to_hash: lineHash("line1"),
				new_text: "x",
			},
		];
		expect(validateEdits(lines, edits)).toContain("out of range");
	});

	it("rejects hash mismatch on from line", () => {
		const lines = ["line1", "line2", "line3"];
		const edits = [
			{
				from: 2,
				from_hash: "xxx",
				to: 3,
				to_hash: lineHash("line3"),
				new_text: "new",
			},
		];
		expect(validateEdits(lines, edits)).toContain("hash mismatch");
	});

	it("rejects hash mismatch on to line", () => {
		const lines = ["line1", "line2", "line3"];
		const edits = [
			{
				from: 1,
				from_hash: lineHash("line1"),
				to: 3,
				to_hash: "xxx",
				new_text: "new",
			},
		];
		expect(validateEdits(lines, edits)).toContain("hash mismatch");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// detectConfusedEditArgs
// ─────────────────────────────────────────────────────────────────────────

describe("detectConfusedEditArgs", () => {
	it("returns null when a valid edits array is present", () => {
		expect(
			detectConfusedEditArgs({
				path: "f.ts",
				edits: [
					{ from: 1, from_hash: "abc", to: 1, to_hash: "abc", new_text: "x" },
				],
			}),
		).toBeNull();
	});

	it("returns null for non-object / null params", () => {
		expect(detectConfusedEditArgs(null)).toBeNull();
		expect(detectConfusedEditArgs("x")).toBeNull();
	});

	it("detects the edit tool's top-level oldText/newText shape", () => {
		const msg = detectConfusedEditArgs({
			path: "f.ts",
			oldText: "defp capacity_full?(shard_id) do\n  ...",
			newText: [{ bogus: true }],
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("oldText");
		expect(msg).toContain("edit` instead");
		expect(msg).toContain("from_hash");
	});

	it("detects old_string/new_string variants", () => {
		const msg = detectConfusedEditArgs({
			path: "f.ts",
			old_string: "a",
			new_string: "b",
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("edit");
	});

	it("returns null when neither edits nor edit-vocab is present", () => {
		expect(detectConfusedEditArgs({ path: "f.ts" })).toBeNull();
	});

	it("returns null even if edits is an empty array (handled later as missing-edits)", () => {
		expect(detectConfusedEditArgs({ path: "f.ts", edits: [] })).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────
// editLinesSchema (corrective relaxation)
// ─────────────────────────────────────────────────────────────────────────

describe("editLinesSchema", () => {
	it("requires only `path` so confused edit-style calls reach execute (not a hard schema rejection)", () => {
		expect(editLinesSchema.required).toEqual(["path"]);
	});

	it("does not reject top-level oldText/newText via additionalProperties", () => {
		expect(editLinesSchema.properties).toHaveProperty("edits");
		// No additionalProperties:false → stray edit-tool keys pass through to execute,
		// where detectConfusedEditArgs returns a corrective error.
		expect(editLinesSchema).not.toHaveProperty("additionalProperties");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// applyEditsToLines
// ─────────────────────────────────────────────────────────────────────────

describe("applyEditsToLines", () => {
	it("replaces a single line", () => {
		const lines = ["line1", "old line", "line3"];
		const edits = [
			{ from: 2, from_hash: "", to: 2, to_hash: "", new_text: "new line" },
		];
		expect(applyEditsToLines(lines, edits)).toEqual([
			"line1",
			"new line",
			"line3",
		]);
	});

	it("replaces a range of lines", () => {
		const lines = ["a", "b", "c", "d"];
		const edits = [
			{ from: 2, from_hash: "", to: 3, to_hash: "", new_text: "x\ny" },
		];
		expect(applyEditsToLines(lines, edits)).toEqual(["a", "x", "y", "d"]);
	});

	it("applies edits in reverse order by 'to' descending", () => {
		const lines = ["a", "b", "c", "d"];
		const edits = [
			{ from: 2, from_hash: "", to: 2, to_hash: "", new_text: "B" },
			{ from: 3, from_hash: "", to: 3, to_hash: "", new_text: "C" },
		];
		// Both edits change different lines — reverse order means line 3 is edited first,
		// then line 2 (which is now line 2 post-edit). Both should work.
		expect(applyEditsToLines(lines, edits)).toEqual(["a", "B", "C", "d"]);
	});

	it("inserts multiple lines from new_text", () => {
		const lines = ["line1", "line2", "line3"];
		const edits = [
			{ from: 2, from_hash: "", to: 2, to_hash: "", new_text: "a\nb\nc" },
		];
		expect(applyEditsToLines(lines, edits)).toEqual([
			"line1",
			"a",
			"b",
			"c",
			"line3",
		]);
	});

	it("removes lines when new_text is empty, leaving empty line placeholder", () => {
		const lines = ["a", "b", "c", "d"];
		const edits = [
			{ from: 2, from_hash: "", to: 3, to_hash: "", new_text: "" },
		];
		// Empty string .split("\n") → [""], so one empty line replaces the range
		expect(applyEditsToLines(lines, edits)).toEqual(["a", "", "d"]);
	});

	it("does not mutate the original array", () => {
		const lines = ["a", "b", "c"];
		const edits = [
			{ from: 2, from_hash: "", to: 2, to_hash: "", new_text: "x" },
		];
		const original = [...lines];
		applyEditsToLines(lines, edits);
		expect(lines).toEqual(original);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// buildEditSummary
// ─────────────────────────────────────────────────────────────────────────

describe("buildEditSummary", () => {
	it("builds a single-edit summary", () => {
		const edits = [
			{ from: 1, from_hash: "", to: 3, to_hash: "", new_text: "x" },
		];
		expect(buildEditSummary(edits, "file.ts")).toContain("1 edit");
		expect(buildEditSummary(edits, "file.ts")).toContain("file.ts");
	});

	it("pluralizes correctly", () => {
		const edits = [
			{ from: 1, from_hash: "", to: 1, to_hash: "", new_text: "x" },
			{ from: 2, from_hash: "", to: 2, to_hash: "", new_text: "y" },
		];
		const summary = buildEditSummary(edits, "main.go");
		expect(summary).toContain("2 edits");
		expect(summary).toContain("main.go");
	});

	it("reports lines changed and added", () => {
		const edits = [
			{ from: 1, from_hash: "", to: 3, to_hash: "", new_text: "a\nb\nc" },
		];
		const summary = buildEditSummary(edits, "test.ts");
		expect(summary).toMatch(/3 line.* replaced/);
		expect(summary).toMatch(/3 line.* added/);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// buildPlanDirective
// ─────────────────────────────────────────────────────────────────────────

describe("buildPlanDirective", () => {
	it("includes the shortcut when provided", () => {
		const directive = buildPlanDirective("ctrl+shift+p");
		expect(directive).toContain("ctrl+shift+p");
	});

	it("includes the fallback command when no shortcut", () => {
		const directive = buildPlanDirective();
		expect(directive).toContain("/deepseek-optimized-plan");
	});

	it("contains PLAN MODE ACTIVE header", () => {
		expect(buildPlanDirective("alt+p")).toContain("PLAN MODE ACTIVE");
	});

	it("contains read-only tools guidance", () => {
		expect(buildPlanDirective()).toContain("read-only tools");
	});

	it("contains the numbered plan structure", () => {
		const directive = buildPlanDirective();
		expect(directive).toContain("1. Read");
		expect(directive).toContain("2. List");
		expect(directive).toContain("3. Explain");
		expect(directive).toContain("4. Note");
	});
});

// ═════════════════════════════════════════════════════════════════════════
// P2-1: Cache E2E tests — reasoning preservation, byte stability, tool sort
// ═════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// reasoning_content handling (P0-1 contract)
// ─────────────────────────────────────────────────────────────────────────

describe("reasoning_content handling", () => {
	it("strips reasoning_content from plain assistant messages (no tool_calls)", () => {
		const msgs: ContextMessage[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: "the answer",
				reasoning_content: "CHAIN-OF-THOUGHT",
			},
		];
		const stripped = stripReasoningSurgical(msgs);
		expect(stripped).toBe(1);
		expect(msgs[1]).not.toHaveProperty("reasoning_content");
		expect(msgs[1]).toHaveProperty("content", "the answer");
	});

	it("preserves reasoning_content on assistant messages with tool_calls", () => {
		const msgs: ContextMessage[] = [
			{ role: "user", content: "count go files" },
			{
				role: "assistant",
				reasoning_content: "CHAIN-OF-THOUGHT",
				tool_calls: [
					{
						id: "c1",
						name: "bash",
						arguments: '{"command":"ls"}',
					},
				],
			},
		];
		const stripped = stripReasoningSurgical(msgs);
		expect(stripped).toBe(0);
		expect(msgs[1]).toHaveProperty(
			"reasoning_content",
			"CHAIN-OF-THOUGHT",
		);
		expect(msgs[1]).toHaveProperty("tool_calls");
	});

	it("preserves reasoning_content with multiple tool_calls", () => {
		const msgs: ContextMessage[] = [
			{ role: "user", content: "read and edit" },
			{
				role: "assistant",
				reasoning_content: "MULTI-TOOL-CHAIN",
				tool_calls: [
					{ id: "c1", name: "read", arguments: '{"path":"a.ts"}' },
					{ id: "c2", name: "grep", arguments: '{"pattern":"foo"}' },
				],
			},
		];
		const stripped = stripReasoningSurgical(msgs);
		expect(stripped).toBe(0);
		expect(msgs[1]).toHaveProperty(
			"reasoning_content",
			"MULTI-TOOL-CHAIN",
		);
	});

	it("strips reasoning from tool messages", () => {
		const msgs: ContextMessage[] = [
			{ role: "user", content: "read file" },
			{
				role: "assistant",
				tool_calls: [
					{ id: "c1", name: "read", arguments: '{"path":"f.ts"}' },
				],
			},
			{
				role: "tool",
				tool_call_id: "c1",
				content: "file content",
				reasoning_content: "LEAKED-CHAIN",
			},
		];
		const stripped = stripReasoningSurgical(msgs);
		expect(stripped).toBe(1);
		expect(msgs[2]).not.toHaveProperty("reasoning_content");
	});

	it("strips reasoning field alongside reasoning_content", () => {
		const msgs: ContextMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: "answer",
				reasoning_content: "chain",
				reasoning: "alt-chain",
			},
		];
		const stripped = stripReasoningSurgical(msgs);
		expect(stripped).toBe(2);
		expect(msgs[1]).not.toHaveProperty("reasoning_content");
		expect(msgs[1]).not.toHaveProperty("reasoning");
	});

	it("leaves user messages untouched", () => {
		const msgs: ContextMessage[] = [
			{
				role: "user",
				content: "question",
				reasoning_content: "should-be-ignored",
			},
		];
		const stripped = stripReasoningSurgical(msgs);
		expect(stripped).toBe(0);
		expect(msgs[0]).toHaveProperty(
			"reasoning_content",
			"should-be-ignored",
		);
	});

	it("handles empty messages array", () => {
		expect(stripReasoningSurgical([])).toBe(0);
	});

	it("strips empty tool_calls array as plain assistant (no real tool calls)", () => {
		const msgs: ContextMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: "answer",
				reasoning_content: "chain",
				tool_calls: [],
			},
		];
		const stripped = stripReasoningSurgical(msgs);
		expect(stripped).toBe(1);
		expect(msgs[1]).not.toHaveProperty("reasoning_content");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// cache: prefix byte-stability e2e
// ─────────────────────────────────────────────────────────────────────────

describe("cache: prefix byte-stability e2e", () => {
	it("produces byte-identical prompt across 50 simulated turns with varying dates", () => {
		// Simulate a real pi system prompt with instructions + date/time/today lines
		const baseInstructions = [
			"You are a helpful coding agent. You have access to tools.",
			"Always verify your changes before applying them.",
			"Use read and grep to understand the codebase before editing.",
		].join("\n");

		const generatePrompt = (dayOffset: number): string => {
			const date = new Date(2026, 2, 21 + dayOffset);
			return [
				baseInstructions,
				`Current date is: ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
				`Current time is: ${10 + (dayOffset % 8)}:${String((dayOffset * 7) % 60).padStart(2, "0")}:00`,
				`Today is: ${date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`,
			].join("\n");
		};

		// Generate 50 prompts with different dates
		const prompts = Array.from({ length: 50 }, (_, i) =>
			generatePrompt(i),
		);

		// Without stripping, every prompt is different
		const uniqueRaw = new Set(prompts);
		expect(uniqueRaw.size).toBe(50); // all 50 are unique

		// With timestamp stripping, all should be byte-identical
		const cleaned = prompts.map((p) => stripTimestampsFromPrompt(p));
		const uniqueCleaned = new Set(cleaned);

		expect(uniqueCleaned.size).toBe(1);
		expect(cleaned[0]).toBe(cleaned[49]);
		// Content preserved; stripTimestampsFromPrompt may leave trailing newlines
		expect(cleaned[0].trim()).toBe(baseInstructions);
	});

	it("byte-stability survives midnight boundary", () => {
		// The most dangerous cache-killer: midnight rollover
		const beforeMidnight = [
			"You are a coding agent.",
			"Current date is: 2026-03-21",
			"Current time is: 23:59:00",
		].join("\n");

		const afterMidnight = [
			"You are a coding agent.",
			"Current date is: 2026-03-22",
			"Current time is: 00:01:00",
		].join("\n");

		expect(stripTimestampsFromPrompt(beforeMidnight)).toBe(
			stripTimestampsFromPrompt(afterMidnight),
		);
	});

	it("byte-stability survives session resume (same base, different date)", () => {
		// When a session is resumed days later, the system prompt prefix must
		// still match for DeepSeek cache hits.
		const originalSession = [
			"You are a coding agent. Use tools carefully.",
			"Current date is: 2026-03-21",
			"Current time is: 10:00:00",
			"Today is: Monday, March 21",
			"",
			"Project context: TypeScript monorepo with strict mode.",
		].join("\n");

		const resumedSession = [
			"You are a coding agent. Use tools carefully.",
			"Current date is: 2026-03-28",
			"Current time is: 14:30:00",
			"Today is: Monday, March 28",
			"",
			"Project context: TypeScript monorepo with strict mode.",
		].join("\n");

		const cleanedOriginal = stripTimestampsFromPrompt(originalSession);
		const cleanedResumed = stripTimestampsFromPrompt(resumedSession);

		expect(cleanedOriginal).toBe(cleanedResumed);
		expect(cleanedOriginal).toContain("Project context:");
		expect(cleanedOriginal).not.toContain("2026-03");
		expect(cleanedOriginal).not.toContain("Monday");
	});

	it("preserves non-date content between stripped lines", () => {
		const prompt = [
			"Instruction block 1.",
			"Current date is: 2026-03-21",
			"Instruction block 2.",
			"Current time is: 14:30:00",
			"Instruction block 3.",
			"Today is: Monday",
			"Instruction block 4.",
		].join("\n");

		const cleaned = stripTimestampsFromPrompt(prompt);
		expect(cleaned).toContain("Instruction block 1.");
		expect(cleaned).toContain("Instruction block 2.");
		expect(cleaned).toContain("Instruction block 3.");
		expect(cleaned).toContain("Instruction block 4.");
		expect(cleaned).not.toContain("2026-03-21");
		expect(cleaned).not.toContain("14:30:00");
		expect(cleaned).not.toContain("Monday");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// cache: tool sort determinism e2e
// ─────────────────────────────────────────────────────────────────────────

describe("cache: tool sort determinism e2e", () => {
	/** Pure sort function matching the cache.ts hook logic exactly. */
	function sortTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
		const sorted = [...tools];
		sorted.sort((a, b) => {
			const fnA = a.function as Record<string, unknown> | undefined;
			const fnB = b.function as Record<string, unknown> | undefined;
			const nameA =
				(fnA?.name as string) ?? (a.name as string) ?? "";
			const nameB =
				(fnB?.name as string) ?? (b.name as string) ?? "";
			return nameA.localeCompare(nameB);
		});
		return sorted;
	}

	it("same tools in different order produce identical sorted output", () => {
		const toolsA = [
			{ function: { name: "z_tool" }, description: "last" },
			{ function: { name: "a_tool" }, description: "first" },
			{ function: { name: "m_tool" }, description: "middle" },
		];

		const toolsB = [
			toolsA[2]!,
			toolsA[0]!,
			toolsA[1]!,
		];

		const sortedA = sortTools(toolsA);
		const sortedB = sortTools(toolsB);

		expect(sortedA).toEqual(sortedB);
		expect(sortedA[0]!.function!.name).toBe("a_tool");
		expect(sortedA[1]!.function!.name).toBe("m_tool");
		expect(sortedA[2]!.function!.name).toBe("z_tool");
	});

	it("sorts mixed OpenAI format (function.name) and direct format (name)", () => {
		const mixedTools = [
			{ name: "bravo" },
			{ function: { name: "alpha" } },
			{ name: "charlie" },
		];

		const sorted = sortTools(mixedTools as Record<string, unknown>[]);

		const names = sorted.map((t) => {
			const fn = t.function as Record<string, unknown> | undefined;
			return (fn?.name as string) ?? (t.name as string) ?? "";
		});
		expect(names).toEqual(["alpha", "bravo", "charlie"]);
	});

	it("handles tools with missing names (falls back to empty string)", () => {
		const tools = [
			{ function: { name: "z_tool" } },
			{ function: { description: "no name here" } }, // no name at all
			{ function: { name: "a_tool" } },
		];

		const sorted = sortTools(tools as Record<string, unknown>[]);

		const names = sorted.map((t) => {
			const fn = t.function as Record<string, unknown> | undefined;
			return (fn?.name as string) ?? (t.name as string) ?? "";
		});
		// Empty string sorts before "a"
		expect(names[0]).toBe("");
		expect(names[1]).toBe("a_tool");
		expect(names[2]).toBe("z_tool");
	});

	it("idempotent: sorting already-sorted tools does not change order", () => {
		const tools = [
			{ function: { name: "a_tool" } },
			{ function: { name: "b_tool" } },
			{ function: { name: "c_tool" } },
		];

		const sortedOnce = sortTools(tools);
		const sortedTwice = sortTools(sortedOnce);

		expect(sortedTwice).toEqual(sortedOnce);
	});

	it("empty tools array is a no-op", () => {
		expect(sortTools([])).toEqual([]);
	});

	it("single tool is unchanged", () => {
		const tools = [{ function: { name: "only_tool" } }];
		expect(sortTools(tools)).toEqual(tools);
	});
});
