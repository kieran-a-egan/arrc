import { test } from "node:test";
import assert from "node:assert/strict";
import { name } from "./index.ts";

test("exports package name", () => {
  assert.equal(name, "@arrc/core");
});