import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CAPABILITY_IDS, npmInstall, resolveCommand, runDoctor, runVersion, satisfies, type Ctx } from "./doctor.ts";

const win = process.platform === "win32";
const doctorPath = path.join(import.meta.dirname, "doctor.ts");
const run = promisify(execFile);

function spacedDir(t: { after: (f: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arrc doctor "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "with space");
  fs.mkdirSync(dir);
  return dir;
}

test("resolveCommand finds commands in a directory with spaces", (t) => {
  const dir = spacedDir(t);
  fs.writeFileSync(path.join(dir, win ? "tool.cmd" : "tool"), "");
  const ctx: Ctx = { platform: process.platform, env: { PATH: `"${dir}"`, PATHEXT: ".EXE;.CMD" } };
  const found = resolveCommand("tool", ctx);
  assert.ok(found?.includes(" "));
  assert.ok(found?.startsWith(dir));
});

test("npm older than devEngines yields npm.cli mismatch (shim layout, no execution)", async (t) => {
  const shim = spacedDir(t);
  const empty = path.dirname(shim);
  fs.writeFileSync(path.join(shim, win ? "npm.cmd" : "npm"), "");
  fs.mkdirSync(path.join(shim, "node_modules", "npm"), { recursive: true });
  fs.writeFileSync(path.join(shim, "node_modules", "npm", "package.json"), JSON.stringify({ name: "npm", version: "11.0.0" }));
  const env: Record<string, string> = { PATH: shim, PATHEXT: ".CMD", HOME: empty, USERPROFILE: empty, SystemRoot: empty, ProgramFiles: empty };
  const c = (await runDoctor({ platform: process.platform, env })).capabilities.find((x) => x.id === "npm.cli");
  assert.equal(c?.status, "mismatch");
  assert.equal(c.version, "11.0.0");
  assert.match(c.remedy ?? "", /12\.0\.2/);
});

test("missing commands yield actionable diagnostics without throwing", async (t) => {
  const empty = spacedDir(t);
  const ctx: Ctx = { platform: process.platform, env: { PATH: empty, HOME: empty, USERPROFILE: empty, SystemRoot: empty } };
  assert.equal(resolveCommand("nope-not-here", ctx), undefined);
  const report = await runDoctor(ctx);
  for (const id of ["git.cli", "shell.pwsh", "claude.cli", "isolation.docker"]) {
    const c = report.capabilities.find((x) => x.id === id);
    assert.equal(c?.status, "missing", id);
    assert.ok(c.remedy, id);
  }
  for (const c of report.capabilities) {
    if (c.status === "missing" || c.status === "mismatch") assert.ok(c.remedy, c.id);
  }
});

test("runVersion executes an exe from a path with spaces", async (t) => {
  const dir = spacedDir(t);
  const exe = path.join(dir, win ? "node.exe" : "node");
  try {
    fs.linkSync(process.execPath, exe);
  } catch {
    fs.copyFileSync(process.execPath, exe);
  }
  const r = await runVersion(exe, ["--version"]);
  assert.equal(r.status, "ok");
  assert.equal(r.output, process.version);
});

test("a .cmd shim is reported unverified and not executed", { skip: !win }, async (t) => {
  const dir = spacedDir(t);
  const marker = path.join(dir, "marker.txt");
  const shim = path.join(dir, "tool.cmd");
  fs.writeFileSync(shim, `@echo ran> "${marker}"\r\n`);
  const r = await runVersion(shim, ["--version"]);
  assert.equal(r.status, "unverified");
  assert.match(r.detail ?? "", /not executed/);
  assert.equal(fs.existsSync(marker), false);
});

test("satisfies handles caret, exact and unsupported ranges", () => {
  assert.equal(satisfies("v24.19.0", "^24.15.0"), true);
  assert.equal(satisfies("v24.14.0", "^24.15.0"), false);
  assert.equal(satisfies("v25.0.0", "^24.15.0"), false);
  assert.equal(satisfies("12.0.2", "12.0.2"), true);
  assert.equal(satisfies("12.0.3", "12.0.2"), false);
  assert.equal(satisfies("1.0.0", ">=1"), undefined);
});

test("CLI --json emits the stable report contract", async () => {
  const { stdout } = await run(process.execPath, [doctorPath, "--json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 1);
  const ids = report.capabilities.map((c: { id: string }) => c.id);
  assert.deepEqual(ids, [...CAPABILITY_IDS]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(report.capabilities.find((c: { id: string }) => c.id === "jev.connectivity").status, "blocked");
});

test("CLI rejects unknown flags with exit code 2", async () => {
  await assert.rejects(run(process.execPath, [doctorPath, "--bogus"]), (e: { code?: number }) => e.code === 2);
});

function npmTree(root: string, where: string, version: string, name = "npm"): string {
  const dir = path.join(root, where, "node_modules", "npm");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(dir, "bin", "npm-cli.js"), "");
  return dir;
}

test("npmInstall prefers the resolved prefix, else the shim dir (win32 shape)", (t) => {
  const root = spacedDir(t);
  const shimDir = path.join(root, "node js");
  const shimNpm = npmTree(root, "node js", "11.0.0");
  const prefixNpm = npmTree(root, "app data/npm", "12.0.2");
  const found = path.join(shimDir, "npm.cmd");
  const ctx: Ctx = { platform: "win32", env: {} };
  assert.deepEqual(npmInstall(found, ctx, path.join(root, "app data", "npm")), { dir: prefixNpm, version: "12.0.2" });
  assert.deepEqual(npmInstall(found, ctx), { dir: shimNpm, version: "11.0.0" });
  assert.deepEqual(npmInstall(found, ctx, path.join(root, "no prefix")), { dir: shimNpm, version: "11.0.0" });
});

test("npmInstall follows the POSIX bin/npm symlink", { skip: win }, (t) => {
  const root = spacedDir(t);
  const npmDir = npmTree(root, "lib", "12.0.2");
  fs.mkdirSync(path.join(root, "bin"));
  const link = path.join(root, "bin", "npm");
  fs.symlinkSync(path.join(npmDir, "bin", "npm-cli.js"), link);
  const r = npmInstall(link, { platform: "linux", env: {} });
  assert.equal(r?.version, "12.0.2");
  assert.equal(fs.realpathSync(r?.dir ?? ""), fs.realpathSync(npmDir));
});

test("npmInstall rejects a package.json whose name is not npm", (t) => {
  const root = spacedDir(t);
  npmTree(root, "shim", "9.9.9", "not-npm");
  const found = path.join(root, "shim", "npm.cmd");
  const r = npmInstall(found, { platform: "win32", env: {} });
  assert.notEqual(r?.version, "9.9.9");
});

test("runDoctor resolves npm via npm-prefix.js (win32)", { skip: !win }, async (t) => {
  const root = spacedDir(t);
  const prefix = path.join(root, "prefix dir");
  const prefixNpm = npmTree(root, "prefix dir", "12.0.2");
  const shim = path.join(root, "shim dir");
  const shimNpm = npmTree(root, "shim dir", "11.0.0");
  fs.writeFileSync(path.join(shim, "npm.cmd"), "");
  fs.writeFileSync(path.join(shimNpm, "bin", "npm-prefix.js"), `console.log(${JSON.stringify(prefix)});`);
  const ctx: Ctx = { platform: "win32", env: { PATH: shim, PATHEXT: ".CMD", HOME: root, USERPROFILE: root, SystemRoot: root } };
  const npm = (await runDoctor(ctx)).capabilities.find((c) => c.id === "npm.cli");
  assert.equal(npm?.version, "12.0.2");
  assert.equal(npm?.path, prefixNpm);
});

test("runDoctor finds Git Bash by walking up from git.exe (win32)", { skip: !win }, async (t) => {
  for (const sub of [["cmd"], ["mingw64", "bin"]]) {
    const root = path.join(spacedDir(t), "Git Root");
    fs.mkdirSync(path.join(root, ...sub), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, ...sub, "git.exe"), "");
    fs.writeFileSync(path.join(root, "bin", "bash.exe"), "");
    const ctx: Ctx = { platform: "win32", env: { PATH: path.join(root, ...sub), PATHEXT: ".EXE", ProgramFiles: root, HOME: root, USERPROFILE: root, SystemRoot: root } };
    const bash = (await runDoctor(ctx)).capabilities.find((c) => c.id === "shell.git-bash");
    assert.equal(bash?.status, "ok", sub.join("/"));
    assert.equal(bash?.path, path.join(root, "bin", "bash.exe"));
  }
});

test("doctor source stays read-only and offline", () => {
  const src = fs.readFileSync(doctorPath, "utf8");
  for (const bad of ["shell: true", "node:http", "node:https", "node:net", "node:dns", "fetch(", "writeFile", "appendFile", "mkdir", "rmSync", "unlink"]) {
    assert.ok(!src.includes(bad), `doctor.ts must not contain ${bad}`);
  }
});
