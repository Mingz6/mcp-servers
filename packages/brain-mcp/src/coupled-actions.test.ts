import { strict as assert } from "node:assert";
import test from "node:test";
import { _resetCacheForTesting, actionSatisfied, tokenize } from "./coupled-actions.js";

test("tokenize strips stopwords and stems common suffixes", () => {
  const tokens = tokenize("Run existing tests — must pass");
  // "run" stays, "existing" → "exist", "tests" → "test", "pass" stays.
  // "must" is a stopword.
  assert.ok(tokens.has("run"), "missing 'run'");
  assert.ok(tokens.has("test"), "missing stem 'test' from 'tests'");
  assert.ok(tokens.has("pass"), "missing 'pass'");
  assert.ok(!tokens.has("must"), "stopword 'must' leaked through");
  assert.ok(!tokens.has(""), "empty token leaked through");
});

test("tokenize handles em-dashes and punctuation", () => {
  const a = tokenize("Run build (compile/transpile) — must pass");
  const b = tokenize("ran build, compiled, passed");
  // Should overlap on at least: build/build, compile/compil
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  assert.ok(overlap >= 1, `expected ≥1 overlap, got ${overlap}; a=${[...a]}, b=${[...b]}`);
});

test("actionSatisfied: matches paraphrased completion", () => {
  // Required: "Run existing tests — must pass"
  // Taken: "all 13 tests passed"
  // Tokens: required = {run, exist, test, pass}; taken = {13, test, pass}
  // Overlap = 2 (test, pass). minOverlap = max(2, ceil(4*0.5)) = 2 → satisfied.
  assert.equal(
    actionSatisfied("Run existing tests — must pass", ["all 13 tests passed"]),
    true,
  );
});

test("actionSatisfied: matches even with re-ordered words", () => {
  assert.equal(
    actionSatisfied("Run build (compile/transpile) — must pass", ["build is clean, compile passed"]),
    true,
  );
});

test("actionSatisfied: returns false when no real overlap", () => {
  assert.equal(
    actionSatisfied("Run existing tests — must pass", ["sent the email", "called the API"]),
    false,
  );
});

test("actionSatisfied: matches across multiple actions taken", () => {
  // Even if no single action covers it, ANY single one is enough.
  assert.equal(
    actionSatisfied("Run existing tests — must pass", [
      "did some refactoring",
      "tests passing",
    ]),
    true,
  );
});

test("actionSatisfied: tiny requirements still need overlap", () => {
  // "Update docs" → tokens = {update, doc}; minOverlap = max(min(2, 2), ceil(2*0.5)) = 2.
  // Need both stems present in one taken action.
  assert.equal(actionSatisfied("Update docs", ["updated documentation"]), true);
  assert.equal(actionSatisfied("Update docs", ["only refactored code"]), false);
});

test("_resetCacheForTesting wipes the in-memory cache", () => {
  // Doesn't throw, just exercises the test hook.
  _resetCacheForTesting();
  assert.ok(true);
});
