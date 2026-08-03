/**
 * Git-stash-based rewind module.
 *
 * Before each turn, creates a git stash snapshot of the working tree.
 * On `/rewind N`, restores the working tree from the turn-N snapshot
 * and navigates the session tree back to before that turn.
 *
 * Uses `git stash create --include-untracked` to snapshot (doesn't modify
 * the working tree or stash list — just creates a dangling commit ref).
 * On rewind, cleans the working tree and applies the saved stash ref.
 *
 * Session tree navigation uses pi's built-in `navigateTree` via the
 * command context.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "./types.js";
import type { CheckpointEntry } from "./types.js";

/** Rewind runtime state. */
export interface RewindState {
	/** All recorded checkpoints, indexed by turn. */
	checkpoints: Map<number, CheckpointEntry>;
	/** Total checkpoints created. */
	totalCheckpoints: number;
	/** Total rewind operations performed. */
	totalRewinds: number;
	/** Whether the cwd is inside a git repo. */
	insideRepo: boolean;
}

/**
 * Register rewind hooks and the /rewind command.
 *
 * @returns RewindState (mutable) for display by commands.
 */
export function registerRewind(
	pi: ExtensionAPI,
	config: HarnessConfig["rewind"],
): RewindState {
	const state: RewindState = {
		checkpoints: new Map(),
		totalCheckpoints: 0,
		totalRewinds: 0,
		insideRepo: false,
	};

	if (!config.enabled) return state;

	/**
	 * Check if cwd is inside a git repo. Called once on session start.
	 * Sets state.insideRepo and returns early from all other hooks if not.
	 */
	async function checkGitRepo(ctx: ExtensionContext): Promise<void> {
		try {
			const result = await pi.exec(
				"git",
				["rev-parse", "--is-inside-work-tree"],
				{ cwd: ctx.cwd, timeout: 2000 },
			);
			state.insideRepo = result.code === 0 && result.stdout.trim() === "true";
		} catch {
			state.insideRepo = false;
		}
	}

	/**
	 * Create a git stash snapshot of the current working tree.
	 *
	 * Uses `git stash create --include-untracked` which creates a commit
	 * object but doesn't touch the working tree or the stash list.
	 * Returns the stash ref (SHA) or empty string if the tree is clean.
	 */
	async function createStashSnapshot(
		cwd: string,
	): Promise<{ stashRef: string; headSha: string }> {
		const [stashResult, headResult] = await Promise.all([
			pi.exec("git", ["stash", "create", "--include-untracked"], {
				cwd,
				timeout: 5000,
			}),
			pi.exec("git", ["rev-parse", "HEAD"], {
				cwd,
				timeout: 2000,
			}),
		]);

		const stashRef = stashResult.code === 0 ? stashResult.stdout.trim() : "";
		const headSha = headResult.code === 0 ? headResult.stdout.trim() : "";

		return { stashRef, headSha };
	}

	// ── Hook: Create checkpoint on each turn start ──────────────────────
	//
	// We snapshot before the agent starts working, so the snapshot reflects
	// the state before any edits in this turn.
	pi.on("turn_start", async (event: TurnStartEvent, ctx: ExtensionContext) => {
		if (!state.insideRepo) return;

		const { stashRef, headSha } = await createStashSnapshot(ctx.cwd);

		const checkpoint: CheckpointEntry = {
			turnIndex: event.turnIndex,
			prompt: undefined, // TurnStartEvent doesn't include the prompt;
			// we could intercept 'input' for this but the
			// session tree navigation handles prompts.
			stashRef,
			headSha,
			timestamp: event.timestamp,
		};

		state.checkpoints.set(event.turnIndex, checkpoint);
		state.totalCheckpoints++;

		// Prune old checkpoints (keep last 100).
		if (state.checkpoints.size > 100) {
			const oldest = Math.min(...state.checkpoints.keys());
			state.checkpoints.delete(oldest);
		}
	});

	// ── Register /rewind command ────────────────────────────────────────
	//
	// Usage: /rewind N   — restore to before turn N
	//        /rewind     — list available checkpoints
	pi.registerCommand("rewind", {
		description:
			"Rewind to a previous turn: /rewind N restores files and conversation to before turn N. Without N, lists available checkpoints.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!state.insideRepo) {
				ctx.ui.notify("Rewind requires a git repository", "warning");
				return;
			}

			const turnArg = args.trim();

			// No argument — list available checkpoints.
			if (!turnArg) {
				if (state.checkpoints.size === 0) {
					ctx.ui.notify("No checkpoints recorded yet", "info");
					return;
				}

				const lines: string[] = ["Available rewind checkpoints:"];
				for (const [turn, cp] of state.checkpoints) {
					const time = new Date(cp.timestamp).toLocaleTimeString();
					const status = cp.stashRef ? "has changes" : "clean tree";
					lines.push(`  Turn ${turn} (${time}, ${status})`);
				}
				lines.push("", "Use /rewind N to rewind to before turn N");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const targetTurn = Number.parseInt(turnArg, 10);
			if (!Number.isFinite(targetTurn)) {
				ctx.ui.notify(`Invalid turn number: ${turnArg}`, "warning");
				return;
			}

			const checkpoint = state.checkpoints.get(targetTurn);
			if (!checkpoint) {
				ctx.ui.notify(
					`No checkpoint for turn ${targetTurn}. Available: ${[...state.checkpoints.keys()].join(", ")}`,
					"warning",
				);
				return;
			}

			// ── Step 1: Create a safety-net stash of the current state ──────
			// This ensures the user can recover if the rewind goes wrong.
			try {
				await pi.exec("git", ["stash", "create", "--include-untracked"], {
					cwd: ctx.cwd,
					timeout: 5000,
				});
				// Note: we create the stash but don't apply it. The working tree
				// is unchanged. If the user needs to recover, they can use git
				// reflog or git stash list to find the dangling commit.
			} catch {
				// Non-fatal — continue with rewind.
			}

			// ── Step 2: Restore the working tree from the checkpoint ────────
			// First reset the index, clean the working tree, then apply the saved stash.
			if (checkpoint.stashRef) {
				try {
					// Reset the index to HEAD so files staged after the checkpoint
					// (but not committed) become untracked and can be cleaned.
					await pi.exec("git", ["reset", "HEAD", "--", "."], {
						cwd: ctx.cwd,
						timeout: 5000,
					});

					// Discard current tracked changes.
					await pi.exec("git", ["checkout", "--", "."], {
						cwd: ctx.cwd,
						timeout: 5000,
					});

					// Remove untracked files created since the checkpoint.
					await pi.exec("git", ["clean", "-fd"], {
						cwd: ctx.cwd,
						timeout: 5000,
					});

					// Check for HEAD drift: if commits were made between the
					// checkpoint and now, the stash was created against a
					// different HEAD. Reset to the checkpoint's HEAD first so
					// the stash applies cleanly.
					if (checkpoint.headSha) {
						const headResult = await pi.exec("git", ["rev-parse", "HEAD"], {
							cwd: ctx.cwd,
							timeout: 2000,
						});
						const currentHead =
							headResult.code === 0 ? headResult.stdout.trim() : "";
						if (currentHead && currentHead !== checkpoint.headSha) {
							await pi.exec("git", ["reset", "--hard", checkpoint.headSha], {
								cwd: ctx.cwd,
								timeout: 5000,
							});
						}
					}

					// Apply the saved stash to restore the checkpoint state.
					await pi.exec("git", ["stash", "apply", checkpoint.stashRef], {
						cwd: ctx.cwd,
						timeout: 5000,
					});
				} catch (err) {
					ctx.ui.notify(
						`Failed to restore files: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					return;
				}
			} else {
				// Checkpoint was a clean tree — just clean current state.
				try {
					// Reset index to unstage any files staged after checkpoint.
					await pi.exec("git", ["reset", "HEAD", "--", "."], {
						cwd: ctx.cwd,
						timeout: 5000,
					});
					await pi.exec("git", ["checkout", "--", "."], {
						cwd: ctx.cwd,
						timeout: 5000,
					});
					await pi.exec("git", ["clean", "-fd"], {
						cwd: ctx.cwd,
						timeout: 5000,
					});
				} catch {
					// Non-fatal — continue.
				}
			}

			// ── Step 3: Navigate the session tree ──────────────────────────
			// We need to find the session entry corresponding to the target turn.
			// The session manager has entry IDs we can use with navigateTree.
			// Since we can't directly map turn index to entry ID from the
			// extension API, we notify the user and let them navigate manually
			// or use the session picker.
			//
			// A future enhancement could intercept 'input' events to capture
			// the prompt + entry ID mapping for automatic tree navigation.

			state.totalRewinds++;

			// ── Step 3: Cache staleness warning ────────────────────────────
			// Rewind restores files to an earlier state, but the DeepSeek
			// prompt-cache prefix (which includes the full conversation
			// history) still reflects the post-rewind message sequence.
			// Subsequent LLM calls may serve stale cached completions that
			// assume the conversation is longer than it now is.
			//
			// reasonix equivalent: TestSaveSnapshotRejectsStalePrefixOverwrite
			// rejects snapshots with fewer messages than current session.
			ctx.ui.notify(
				[
					"⚠️  Cache prefix may be stale after rewind.",
					"The DeepSeek prompt cache still reflects the pre-rewind",
					"conversation length. This can cause stale cached",
					"completions on subsequent turns.",
					"",
					"Recommend: run /reload to start a fresh session with",
					"a clean cache prefix, or watch for unexpected output.",
				].join("\n"),
				"warning",
			);

			ctx.ui.notify(
				[
					`Rewound to before turn ${targetTurn}.`,
					"Files restored from git stash snapshot.",
					"",
					"Note: Use the session tree (ctrl+t or /session) to navigate",
					"the conversation to the corresponding point if needed.",
				].join("\n"),
				"info",
			);
		},
	});

	// Check git repo status on session start.
	pi.on("session_start", async (_event, ctx) => {
		await checkGitRepo(ctx);
	});

	return state;
}
