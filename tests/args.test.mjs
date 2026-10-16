import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/args.mjs";

const SPEC = {
  "--json": { key: "json", type: "bool" },
  "--model": { key: "model", type: "string", aliases: ["-m"] },
  "--resume": { key: "resume", type: "bool" },
};

test("boolean flags", () => {
  const { flags, rest } = parseArgs(["--json", "hello"], SPEC);
  assert.equal(flags.json, true);
  assert.deepEqual(rest, ["hello"]);
});

test("value flags via space and equals", () => {
  assert.equal(parseArgs(["--model", "gpt"], SPEC).flags.model, "gpt");
  assert.equal(parseArgs(["--model=gpt"], SPEC).flags.model, "gpt");
  assert.equal(parseArgs(["-m", "gpt"], SPEC).flags.model, "gpt");
});

test("a bool flag never swallows the positional prompt", () => {
  const { flags, rest } = parseArgs(["--resume", "fix", "the", "bug"], SPEC);
  assert.equal(flags.resume, true);
  assert.deepEqual(rest, ["fix", "the", "bug"]);
});

test("explicit false", () => {
  assert.equal(parseArgs(["--json=false"], SPEC).flags.json, false);
});

test("double dash stops flag parsing", () => {
  const { flags, rest } = parseArgs(["--", "--model", "x"], SPEC);
  assert.equal(flags.model, undefined);
  assert.deepEqual(rest, ["--model", "x"]);
});

test("unknown flag is an error", () => {
  assert.throws(() => parseArgs(["--nope"], SPEC), /Unknown option --nope/);
});

test("missing value is an error", () => {
  assert.throws(() => parseArgs(["--model"], SPEC), /requires a value/);
});
