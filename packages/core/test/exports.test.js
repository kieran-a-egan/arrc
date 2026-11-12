// Plain JS outside src/ so tsc skips it: dist/index.d.ts doesn't exist on a clean build.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "@arrc/core";

test("package entry point resolves by name", () => {
  assert.equal(core.name, "@arrc/core");
});
