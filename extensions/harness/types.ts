/**
 * Shared types for the pi-harness extension.
 *
 * The harness extension implements five techniques from the cwcode Substack
 * post for closing the quality gap between DeepSeek V4 Pro and Claude:
 *
 * 1. Cache prefix stability — strip reasoning_content, sort tools, remove timestamps
 * 2. Storm-breaker — enhance tool errors and break repeated-failure loops
 * 3. Hashline editing — hash-annotated read output + hash-verified edit_lines tool
 * 4. Plan mode — dynamically restrict tools to read-only
 * 5. Rewind — git-stash-based file snapshots + session tree navigation
 */

/** Full configuration for the harness extension, parsed from environment variables. */
export interface HarnessConfig {
	/** Master switch. When false, no hooks fire and no tools are registered. */
	enabled: boolean;
	/**
	 * Comma-separated model patterns. Cache and hashline modules only activate
	 * when the active model's provider, id, or name matches one of these
	 * (case-insensitive substring). Storm-breaker and plan mode are always on.
	 */
	modelPattern: string[];
	cache: {
		enabled: boolean;
		/** Strip reasoning_content from assistant messages before each LLM call. */
		stripReasoning: boolean;
		/** Sort tool schemas deterministically in the outbound request payload. */
		sortTools: boolean;
		/** Remove dynamic timestamps/dates from the system prompt. */
		stripTimestamps: boolean;
	};
	hashlines: {
		enabled: boolean;
	};
	stormbreaker: {
		enabled: boolean;
		/** Number of consecutive identical failures before breaking the loop. */
		threshold: number;
		/** Escalation strategy: "guard_then_abort" (inject guard into tool result first, abort on next failure) or "abort" (current behavior). */
		escalation: "guard_then_abort" | "abort";
	};
	planmode: {
		enabled: boolean;
		/** Keyboard shortcut to toggle plan mode, or undefined to disable. */
		shortcut: string | undefined;
		/** Tools available in plan mode (read-only). */
		readonlyTools: string[];
	};
	rewind: {
		enabled: boolean;
		/** Snapshot strategy. "git" uses git stash. */
		strategy: "git";
	};
}

/** A checkpoint recorded before each turn for use by /rewind. */
export interface CheckpointEntry {
	/** 0-based turn index from TurnStartEvent. */
	turnIndex: number;
	/** The user prompt that started this turn, if available. */
	prompt: string | undefined;
	/** Git stash ref created by `git stash create --include-untracked`. Empty string if clean tree. */
	stashRef: string;
	/** Current HEAD SHA for reference. */
	headSha: string;
	/** Unix timestamp (ms). */
	timestamp: number;
}

/** Record of a tool failure for storm-breaker tracking. */
export interface FailureRecord {
	/** Tool name that failed. */
	toolName: string;
	/** Normalized error signature for deduplication. */
	errorSignature: string;
	/** Consecutive failure count. */
	count: number;
	/** Last toolCallId that failed. */
	lastToolCallId: string;
	/** Whether a guard message has been injected into the tool result (tier 1 escalation). */
	guarded: boolean;
}

/** A single hash-anchored edit in an edit_lines call. */
export interface HashEdit {
	/** 1-based start line number. */
	from: number;
	/** Expected hash at the from line. */
	from_hash: string;
	/** 1-based end line number (inclusive). */
	to: number;
	/** Expected hash at the to line. */
	to_hash: string;
	/** Replacement text for lines from..to. */
	new_text: string;
}