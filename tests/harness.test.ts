import { afterEach, describe, expect, it } from "vitest";
import {
	lineHash,
	annotateLine,
	annotateContent,
	isAnnotated,
	enhanceError,
	errorSignature,
	extractErrorText,
	tailOf,
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

	// ⚠️ THIS TEST USED TO PIN THE BUG. It asserted `extractErrorText` caps at 500,
	// which is what destroyed every failing test run: pytest's verdict is at the END,
	// so a 500-character HEAD slice delivered progress dots and nothing else.
	it("does NOT truncate long output", () => {
		const longText = "x".repeat(600);
		const content = [{ type: "text", text: longText }];
		expect(extractErrorText(content).length).toBe(600);
		expect(extractErrorText(content)).toBe(longText);
	});

	it("keeps a pytest verdict that appears after the progress dots", () => {
		// Shape of a real `hack.py itest-gate` result: ~900 bytes of dots, verdict last.
		const dots = ".................. [ 12%]\n".repeat(30);
		const output =
			dots +
			"FAILED tests/integration/test_import_upload.py::test_upload_accepts_csv\n" +
			"1 failed, 554 passed in 38.41s\n";
		const extracted = extractErrorText([{ type: "text", text: output }]);
		expect(extracted).toContain("1 failed, 554 passed");
		expect(extracted).toContain("test_upload_accepts_csv");
		expect(extracted.length).toBe(output.length);
	});

	it("handles empty content", () => {
		expect(extractErrorText([])).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// tailOf
// ─────────────────────────────────────────────────────────────────────────

describe("tailOf", () => {
	it("returns short text untouched", () => {
		expect(tailOf("short", 100)).toBe("short");
	});

	it("is a no-op at exactly the limit", () => {
		const exact = "x".repeat(100);
		expect(tailOf(exact, 100)).toBe(exact);
	});

	it("keeps the END and marks the elision", () => {
		const text = "A".repeat(900) + "VERDICT";
		const result = tailOf(text, 100);
		expect(result.endsWith("VERDICT")).toBe(true);
		expect(result.startsWith("…")).toBe(true);
		expect(result.length).toBe(101); // ellipsis + 100 chars
	});

	it("never reads past the end for a zero budget", () => {
		expect(tailOf("anything", 0)).toBe("");
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

	// ⚠️ RED BEFORE THIS FIX, AND IT ABORTED WORKING AGENTS. Both runs below are
	// typical failing pytest results with IDENTICAL leading progress dots. Because the
	// signature was taken from the head, both hashed to the same key; three such
	// "identical" failures reach the threshold and the storm-breaker calls
	// ctx.abort(), killing an agent mid-investigation.
	it("distinguishes failures that share a long identical prefix", () => {
		const dots = ".................. [ 12%]\n".repeat(30);
		const runA =
			dots + "FAILED tests/test_a.py::test_one - AssertionError: alpha\n1 failed, 9 passed";
		const runB =
			dots + "FAILED tests/test_b.py::test_two - AssertionError: beta\n2 failed, 8 passed";
		expect(errorSignature("bash", runA)).not.toBe(errorSignature("bash", runB));
	});

	it("still collapses a genuinely repeated failure", () => {
		const run = "FAILED tests/test_a.py::test_one - AssertionError: alpha\n1 failed, 9 passed";
		expect(errorSignature("bash", run)).toBe(errorSignature("bash", run));
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

	// ⚠️ THIS TEST USED TO PIN THE BUG. The default branch returned
	// `[${toolName}] ${errorText}`, which ALWAYS differed from the input — so the
	// caller's `enhanced === errorText` stand-down never fired and EVERY failing
	// command had its result replaced. Returning the input unchanged is what makes
	// that check meaningful.
	it("returns unrecognised errors UNCHANGED, so the caller can stand down", () => {
		const original = "command not found: weirdcmd";
		const result = enhanceError("bash", original);
		expect(result).toBe(original);
	});

	it("appends guidance instead of replacing the error text", () => {
		// The caller substitutes this for the WHOLE tool result, so anything dropped
		// here is deleted from what the model sees.
		for (const [input, needle] of [
			["open : no such file or directory", "empty or missing"],
			["permission denied", "not readable"],
			["old_text did not match anything in the file", "re-read"],
			["offset 500 is beyond end of file (100 lines total)", "shorter than expected"],
		] as const) {
			const result = enhanceError("read", input);
			expect(result.startsWith(input)).toBe(true);
			expect(result).toContain(needle);
		}
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
