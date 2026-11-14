import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { system32 } from "./doctor.ts";

// Pre-flight scan: can the PreToolUse gate hook be trusted to register and run? Presence/shape only: no setting
// value is ever returned or logged, reasons carry only a source label and a key name. Key and path names were
// found by string search of CLI 2.1.325 (not live-verified).
export interface HookTrust {
  trusted: boolean;
  reasons: string[];
  /** presence only: apiKeyHelper, a settings env block setting a key/token/base-url/cloud flag, or primaryApiKey in <config dir>/.claude.json (unreadable counts as true) */
  apiKeyInSettings: boolean;
}

const HOOK_OFF_KEYS = ["disableAllHooks", "allowManagedHooksOnly", "strictPluginOnlyCustomization"];
const HOOK_OFF_ENV = ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_PERSONAL_HOOKS_OFF", "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG"];
/** Cloud/gateway provider switches (names found by string search of CLI 2.1.325): any non-empty value means non-subscription billing. */
export const CLOUD_ENV = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY"];
const KEY_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", ...CLOUD_ENV];
const WIDE_MODES = ["bypassPermissions", "acceptEdits", "auto"];
const truthyEnv = (v: unknown) => typeof v === "string" && v !== "" && !/^(0|false|no|off)$/i.test(v);

/** True if dir or any ancestor has .git (dir or file): the CLI resolves project/local settings from the git root, not cwd. */
export function insideGitRepo(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** Presence-only registry policy probe (win32): never reads values. Not-found is the only clean answer; anything else is untrusted. */
function regKeyState(key: string): "absent" | "present" | "error" {
  const reg = system32("reg.exe");
  const r = spawnSync(reg, ["query", key], { shell: false, windowsHide: true, encoding: "utf8" });
  if (r.error || r.status === null) return "error";
  if (r.status === 0) return "present";
  return r.status === 1 && /unable to find the specified registry key/i.test(r.stderr ?? "") ? "absent" : "error"; // English-locale text; other locales fail closed
}

/** Managed-settings dir per the CLI binary. ponytail: remote/MDM policy is NOT scanned (residual risk). */
export const managedDirFor = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "C:\\Program Files\\ClaudeCode" : platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";

export function scanHookTrust(o: { env: NodeJS.ProcessEnv; cwd: string; home: string; platform: NodeJS.Platform; managedDir?: string; regState?: (key: string) => "absent" | "present" | "error" }): HookTrust {
  const norm = (k: string) => (o.platform === "win32" ? k.toLowerCase() : k);
  const missing = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");
  const reasons: string[] = [];
  let apiKeyInSettings = false;
  const seen = new Map(Object.entries(o.env).map(([k, v]) => [norm(k), v]));
  for (const k of HOOK_OFF_ENV) if (truthyEnv(seen.get(norm(k)))) reasons.push(`env ${k}`);

  // The CLI resolves project/local settings from the git root (via --project-config-root, a flag only; no env var), so any repo above cwd is unscannable.
  if (insideGitRepo(o.cwd)) reasons.push("cwd inside a git repository");
  if (o.platform === "win32")
    for (const k of ["HKLM", "HKCU"]) {
      const st = (o.regState ?? regKeyState)(`${k}\\SOFTWARE\\Policies\\ClaudeCode`);
      if (st !== "absent") reasons.push(`registry policy ${k} ${st}`);
    }
  // Global config: primaryApiKey (presence only; unreadable or invalid fails closed for billing).
  try {
    const g = JSON.parse(fs.readFileSync(path.join(o.env.CLAUDE_CONFIG_DIR || o.home, ".claude.json"), "utf8"));
    if (!g || typeof g !== "object" || typeof g.primaryApiKey === "string") apiKeyInSettings = true;
  } catch (e) {
    if (!missing(e)) apiKeyInSettings = true;
  }

  const managed = o.managedDir ?? managedDirFor(o.platform);
  const sources: [string, string][] = [
    ["user settings", path.join(o.env.CLAUDE_CONFIG_DIR || path.join(o.home, ".claude"), "settings.json")],
    ["project settings", path.join(o.cwd, ".claude", "settings.json")],
    ["project local settings", path.join(o.cwd, ".claude", "settings.local.json")],
    ["managed settings", path.join(managed, "managed-settings.json")],
  ];
  try {
    for (const f of fs.readdirSync(path.join(managed, "managed-settings.d")).filter((n) => n.endsWith(".json")).sort())
      sources.push([`managed drop-in ${f}`, path.join(managed, "managed-settings.d", f)]);
  } catch (e) {
    if (!missing(e)) reasons.push("managed drop-in dir unreadable");
  }

  for (const [label, file] of sources) {
    let s: any;
    try {
      s = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (!missing(e)) reasons.push(`${label} unreadable or invalid`);
      continue;
    }
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      reasons.push(`${label} unreadable or invalid`);
      continue;
    }
    for (const k of HOOK_OFF_KEYS) if (s[k]) reasons.push(`${label} sets ${k}`);
    if (WIDE_MODES.includes(s.permissions?.defaultMode)) reasons.push(`${label} sets permissions.defaultMode to a widening mode`);
    if (s.apiKeyHelper) apiKeyInSettings = true;
    const env = s.env && typeof s.env === "object" ? (s.env as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(env)) {
      if (HOOK_OFF_ENV.some((h) => norm(h) === norm(k)) && truthyEnv(v)) reasons.push(`${label} env sets ${k}`);
      if (KEY_ENV.some((h) => norm(h) === norm(k)) && v) apiKeyInSettings = true;
    }
  }
  return { trusted: reasons.length === 0, reasons, apiKeyInSettings };
}
