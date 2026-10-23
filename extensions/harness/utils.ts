/**
 * Shared utilities for the pi-harness extension.
 *
 * Line hashing uses FNV-1a 32-bit (same family as the cwcode implementation)
 * truncated to 12 bits (3 hex chars). The hash is computed on trailing-
 * whitespace-trimmed content so edits that only change trailing spaces don't
 * cause spurious mismatches.
 */

/**
 * Compute a 3-character hex hash for a line of content.
 * The hash is based on trailing-whitespace-trimmed content.
 */
export function lineHash(line: string): string {
	const trimmed = line.replace(/\s+$/, "");
	let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
	for (let i = 0; i < trimmed.length; i++) {
		hash ^= trimmed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV-1a prime
	}
	// Take lowest 12 bits → 3 hex chars
	return (hash & 0xfff).toString(16).padStart(3, "0");
}

/**
 * Format a line number with its hash annotation.
 *
 * Output format: `     N:HHH→content`
 * The line number is right-padded to 5 chars for alignment with 3-digit+ lines.
 * The hash is 3 hex chars. The `→` separates annotation from content.
 */
export function annotateLine(lineNumber: number, content: string): string {
	const num = String(lineNumber).padStart(5, " ");
	const hash = lineHash(content);
	return `${num}:${hash}\u2192${content}`;
}

/** The regex used to detect already-annotated lines (to avoid double-annotation). */
const ANNOTATED_RE = /^\s*\d+:([0-9a-f]{3})\u2192/;

/** Check whether a line already has a hash annotation. */
export function isAnnotated(line: string): boolean {
	return ANNOTATED_RE.test(line);
}

/**
 * Detect truncation/continuation notice lines from the read tool.
 *
 * Matches the actual pi read tool output format:
 *   [Showing lines 1-50 of 200. Use offset=51 to continue.]
 *   [...output truncated. Type 'more' to continue.]
 *
 * Does NOT match TOML/INI section headers like [section], JSON array
 * snippets like [1, 2, 3], or other bracketed content that is real
 * file content requiring annotation.
 */
const isNoticeLine = (line: string): boolean =>
	line.startsWith("[Showing") ||
	(line.startsWith("[") && line.includes("to continue.]"));

/**
 * Annotate raw file content with line numbers and hashes.
 *
 * @param content Raw file content (newline-separated)
 * @param startLine 1-based line number of the first line (for offset reads)
 * @returns Annotated content where each line is `     N:HHH→original line content`
 *
 * Truncation notice lines (e.g. [Showing lines 1-50 of 200...]) are
 * left un-annotated so the model can distinguish them from file content.
 * Blank separator lines immediately before a notice are also skipped
 * (they are display artifacts, not real file lines).
 */
export function annotateContent(content: string, startLine = 1): string {
	const lines = content.split("\n");
	const result: string[] = [];
	let lineNum = startLine;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		if (isNoticeLine(line)) {
			// Truncation/continuation notice: pass through without annotation.
			result.push(line);
			continue;
		}

		if (line === "" && i + 1 < lines.length && isNoticeLine(lines[i + 1]!)) {
			// Blank line immediately before a truncation notice — it's a display
			// artifact, not a real file line. Pass through without annotation.
			result.push(line);
			continue;
		}

		if (isAnnotated(line)) {
			// Already annotated (e.g., re-read after our hook) — pass through.
			result.push(line);
		} else {
			result.push(annotateLine(lineNum, line));
		}
		lineNum++;
	}

	return result.join("\n");
}

/**
 * Extract the error message from a tool result's content array.
 *
 * Tool results contain `(TextContent | ImageContent)[]`. We concatenate all text
 * content so callers can see the failure as the tool reported it.
 *
 * ⚠️ THIS MUST NOT TRUNCATE. It used to end in `.slice(0, 500)`, and that single
 * line destroyed every failing test run an agent made.
 *
 * The measurement, 2026-10-23: `hack.py itest-gate` streams ~900 bytes of pytest
 * progress and puts the verdict LAST. A head-slice to 500 kept 30 lines of dots
 * and discarded "1 failed, 554 passed", so the model received a result of exactly
 * 507 characters — `"[bash] "` + 500 — and concluded the run had been cut off
 * while the operator watched it finish. That length occurred 58 times in one
 * worktree. Successful results in the same sessions were 600+ characters and
 * arrived intact, so the cap was ours and it applied only to the error path:
 * precisely the path where the agent must read what happened to correct course.
 *
 * Bounding is not this function's job. The bash tool already truncates its own
 * result to 2000 lines / 50KB and names a spill file for the remainder.
 */
export function extractErrorText(
	content: { type: string; text?: string; data?: string }[],
): string {
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}

/**
 * The LAST `maxChars` characters, marked as elided when anything was dropped.
 *
 * ⚠️ THE TAIL IS THE ONLY END WORTH KEEPING. Every tool an agent runs puts its
 * conclusion last: pytest's summary, a traceback's final exception, a compiler's
 * error count, the shell's exit status. A head-slice keeps the preamble and throws
 * the answer away.
 *
 * The leading ellipsis is load-bearing. A silently shortened string is
 * indistinguishable from a complete one, and a fragment that looks authoritative
 * is worse than a short message.
 */
export function tailOf(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	return `…${text.slice(-maxChars)}`;
}

/**
 * Normalize an error message into a signature for consecutive-failure dedup.
 *
 * Strips file-specific details (paths, line numbers, timestamps) so that
 * "Error: open /foo/bar.txt: no such file" and "Error: open /baz/qux.txt: no such file"
 * are considered the same failure class.
 */
export function errorSignature(toolName: string, errorText: string): string {
	// ⚠️ THE SIGNATURE IS DERIVED FROM THE TAIL, AND IT USED TO BE DERIVED FROM THE HEAD.
	//
	// Measured 2026-10-23: two runs of DIFFERENT failing tests produced the SAME
	// signature, because both inputs were the first 500 bytes of pytest progress dots:
	//
	//   run A: "bash:.................. [ 12%]\n.................. [ 12%]\n..."
	//   run B: "bash:.................. [ 12%]\n.................. [ 12%]\n..."   <- identical
	//
	// Three such "identical" failures reach the storm-breaker threshold and it calls
	// ctx.abort(), killing a working agent mid-investigation. The abort is not a false
	// positive on the TOOL; it is a false positive on the SIGNATURE, so fixing what the
	// signature reads fixes the abort. The tail is where failures actually differ.
	const normalized = tailOf(errorText, 4000)
		.replace(/\/[^\s:]+/g, "<path>") // file paths
		.replace(/line \d+/gi, "line N") // line numbers
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<timestamp>") // ISO timestamps
		.replace(/\b0x[0-9a-f]+\b/gi, "<hex>"); // hex addresses
	// Cap the KEY, not the reading of it: a dedup key only has to be stable and
	// distinctive, and after normalization the distinction lives in the tail.
	return `${toolName}:${tailOf(normalized, 500)}`;
}

/**
 * Enhance a raw tool error message to be more actionable.
 *
 * Catches common unhelpful error patterns and APPENDS guidance that tells the model
 * *what to fix*, not just *what broke*.
 *
 * ⚠️ THE TWO CONTRACTS THIS FUNCTION MUST HOLD, AND USED TO BREAK.
 *
 * 1. APPEND, NEVER REPLACE. The caller substitutes this return value for the WHOLE
 *    tool result (`content: [{ type: "text", text: enhanced }]`), so anything not
 *    contained in the returned string is DELETED from what the model sees. Two
 *    branches used to return guidance alone and threw the tool's own words away.
 *
 * 2. RETURN THE INPUT UNCHANGED WHEN THERE IS NO GUIDANCE TO ADD. The caller's
 *    `enhanced === errorText` check is what keeps the hook from rewriting results
 *    that need no help. The default branch used to return `[${toolName}] ${errorText}`,
 *    which ALWAYS differed, so that check never fired and every failing command had
 *    its output replaced. That is the mechanism by which a failing test run lost
 *    pytest's verdict. The tool name is already on the result (`toolName` on the
 *    toolResult message), so prefixing it here bought nothing and cost the output.
 */
export function enhanceError(toolName: string, errorText: string): string {
	// Empty path errors
	if (
		/open\s*:?\s*no such file/i.test(errorText) ||
		/no such file or directory/i.test(errorText)
	) {
		if (/open\s+:|open\s+''/.test(errorText) || errorText.includes('""')) {
			return `${errorText}\n\nError: the 'path' argument is empty or missing. Please provide a valid file path.`;
		}
	}

	// Permission errors
	if (/permission denied/i.test(errorText)) {
		return `${errorText}\n\nThis usually means the file is not readable. Check the path and permissions.`;
	}

	// Edit tool partial-match errors — include the actual content for context.
	// Only match edit-specific patterns to avoid catching unrelated 'not found' errors.
	if (
		/old_text.*not found|old_string.*not found|did not match|exact string.*not found/i.test(
			errorText,
		)
	) {
		return `${errorText}\n\nThe exact string was not found in the file. This commonly happens when:\n- The file was modified since you last read it (re-read the file)\n- Whitespace differs (tabs vs spaces, trailing whitespace)\n- You are matching content from an outdated read\nSuggestion: use read to get fresh content, then retry.`;
	}

	// Offset out of bounds
	if (/offset.*beyond end of file/i.test(errorText)) {
		return `${errorText}\nThe file may be shorter than expected. Use read without offset to see the full file.`;
	}

	// Default: no guidance applies. Return the input UNCHANGED so the caller's
	// `enhanced === errorText` check short-circuits and the tool result is left
	// exactly as the tool produced it. See contract (2) in the docstring.
	return errorText;
}

/**
 * Check whether a model matches any of the given patterns (case-insensitive
 * substring match against the model's provider, id, or name).
 *
 * Used to gate cache and hashline modules to DeepSeek-like models only.
 * Returns false when model is undefined (no model selected yet).
 */
export function matchesModelPattern(
	model: { id: string; provider: string; name: string } | undefined,
	patterns: string[],
): boolean {
	if (!model || patterns.length === 0) return false;
	const haystack = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
	return patterns.some((p) => haystack.includes(p.toLowerCase()));
}
