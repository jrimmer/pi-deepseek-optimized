# Fix Plan: pi-deepseek-optimized → reasonix parity

Based on findings and reasonix source analysis.

## P0: Reasoning strip — blanket → surgical

**reasonix pattern** (`openai_test.go:491-563`):
- `TestBuildRequestDropsReasoningOnPlainAssistantTurn` — plain assistant turn MUST NOT carry `reasoning_content`
- `TestBuildRequestRoundTripsReasoningOnDeepSeekToolCalls` — tool-call turn MUST carry it for DeepSeek, MUST NOT for non-DeepSeek

**Current bug** (`cache.ts:80-110`): Strips `reasoning_content` from ALL assistant/tool messages unconditionally.
**Fix**: Check `tool_calls` presence before stripping. Preserve `reasoning_content` when message has non-empty `tool_calls` array.

```typescript
// In the context hook loop, before the delete:
if (role === "assistant") {
  const hasToolCalls = "tool_calls" in anyMsg && 
    Array.isArray(anyMsg.tool_calls) && 
    (anyMsg.tool_calls as any[]).length > 0;
  if (hasToolCalls) continue; // DeepSeek requires reasoning round-trip on tool-call turns
}
```

**Tests to add**: Verify reasoning_content preserved on tool_call messages, stripped on plain messages.

---

## P1-1: Storm-breaker — abort → tool-result injection

**reasonix pattern** (`agent.go:2145-2219`, `applyStormBreaker`):
1. Computes `batchStormSignature` — `(toolName + NUL + errMsg)` for each call, ok only when ALL calls errored/blocked
2. Tracks `stormSig` / `stormCount` for same-signature streak
3. Tracks `blockedTurnStreak` — all calls blocked in a turn
4. On threshold: **injects guard into tool result** → `results[0] = outcomes[0].output + "\n\n" + guard`
5. Arms `loopGuardPass` so model can report blocker instead of retrying
6. Two hit paths: stormSig (same failure 3x) OR blockedTurnStreak (all blocked 3 turns)

**Current bug** (`stormbreaker.ts:110-140`): `ctx.abort()` + `sendMessage()` to user. Model never sees failure.
**Fix**: Three-tier:

| Tier | Condition | Action |
|---|---|---|
| 1 | count == threshold | Inject guard into tool result (model sees it via `return { content: [enhanced] }`) Set `guarded: true` on FailureRecord |
| 2 | count == threshold+1, guarded | `ctx.abort()` + user message (current behavior) |

**New types**:
```typescript
interface FailureRecord {
  // ... existing ...
  guarded: boolean; // true after first guard injection
}
interface StormBreakerState {
  // ... existing ...
  blockedTurnStreak: number;
  previousTurnHadSuccess: boolean;
}
```

**New config**: `PI_HARNESS_STORMBREAKER_ESCALATION` default `"guard_then_abort"`

**Where**: `extensions/harness/stormbreaker.ts`, `tool_execution_end` handler. Instead of always aborting on `thresholdReached`, return modified tool content first time, abort second time.

---

## P1-2: Storm-breaker — blocked-turn streak

**reasonix pattern** (`agent.go:408-415`, `applyStormBreaker`):
- `blockedTurnStreak int` — consec turns where EVERY call was blocked
- Reset on any turn with non-blocked outcome
- On streak ≥ threshold, inject different guard: "every tool call in the last N turns has been blocked..."

**Current**: No streak tracking.
**Fix**: Add `blockedTurnStreak` counter. Track in `turn_start` + `tool_execution_end` hooks. Inject streak-based guard when streak ≥ threshold (separate guard message from sig-based one).

---

## P1-3: Rewind — cache-aware restore

**reasonix pattern** (`save_test.go:94-122`, `TestSaveSnapshotRejectsStalePrefixOverwrite`):
- If snapshot has fewer messages than current session, it's a stale prefix → reject with `ErrSessionSnapshotConflict`
- `TestSaveSnapshotAllowsAppendFromDiskPrefix` — append (longer prefix) is allowed

**Current** (`rewind.ts`): Just applies git stash, no cache awareness. After rewind, DeepSeek cache prefix is stale but pi doesn't know.
**Fix**: After restore, emit warning that cache may be stale. If pi API supports it, invalidate context cache. Minimum: loud warning + recommend `/reload`.

---

## P2-1: Cache E2E tests

**reasonix pattern** (`cachehit_e2e_test.go`):
- `TestCacheHitPrefixStable` — runs real agent loop, verifies cache hit rate climbs across turns
- `TestCacheHitClimbsWithoutCompaction` — verifies hits survive across turns without compaction
- `TestCacheHitSurvivesTooSmallWindow` — edge case

**Current**: Tests are pure-function only. No hook-layer tests for reasoning preservation, byte stability, or tool sort.
**Fix**: Add `tests/cache-e2e.test.ts`:
1. `describe("reasoning_content handling")` — mock context event, verify strip/preserve logic
2. `describe("prefix byte-stability e2e")` — mock multi-turn messages, verify timestamp strip + tool sort produce identical bytes
3. `describe("tool sort determinism")` — mock `before_provider_request`, verify sorted output

---

## P2-2: Benchmark recalibration

**Current**: Uses 16K tokens/turn, projects $6.51 vs README's $0.40-$0.80. Simplified model doesn't match README claims.
**Fix**: Measure real token counts from pi+DeepSeek session or use DeepSeek's documented cache hit pricing ($0.001/1K hit, $0.12/1K miss) with realistic context sizes. Update README if projections differ.

---

## Implementation order

1. **P0-1** — correctness bug, blocks everything
2. **P2-1** — tests for P0-1, prevents regressions
3. **P1-1** — biggest UX improvement, reasonix-competitive
4. **P1-2** — small addition, high signal for blocked loops
5. **P1-3** — cache-aware rewind
6. **P2-2** — benchmark honesty

## Files changed

| File | Changes |
|---|---|
| `extensions/harness/cache.ts` | P0-1: check tool_calls before stripping reasoning |
| `extensions/harness/stormbreaker.ts` | P1-1: guard injection, P1-2: streak tracking |
| `extensions/harness/types.ts` | P1-1, P1-2: FailureRecord.guarded, StormBreakerState.blockedTurnStreak |
| `extensions/harness/config.ts` | P1-1: PI_HARNESS_STORMBREAKER_ESCALATION |
| `extensions/harness/rewind.ts` | P1-3: cache awareness warning |
| `tests/harness.test.ts` | P2-1: reasoning preservation, byte stability, tool sort tests |
| `tests/benchmarks.test.ts` | P2-2: cost calibration |

## Verification

After each fix: `npm test && npm run typecheck` must pass.
After P0-1: manual test with actual DeepSeek API — tool-call turns must not 400.
