/**
 * Launcher-scoped device model discovery and safe spawn-option resolution.
 *
 * Adapter responses are process-boundary values. The decoder functions below
 * validate these values before they enter the domain model.
 */
/* eslint-disable
 * anti-slop/no-chained-type-assertions,
 * anti-slop/no-conditional-empty-object-spread,
 * anti-slop/no-known-value-widening,
 * anti-slop/no-runtime-typeof,
 * anti-slop/no-unknown-parameters,
 * anti-slop/no-unknown-returns,
 * anti-slop/no-unsafe-dictionary-type,
 * anti-slop/require-safety-comment-for-type-assertion
 */

import { isAbsolute, resolve } from "node:path";
import { validModelIdentifier } from "./validate";

const CATALOGUE_TTL_MS = 5 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CATALOGUE_MODELS = 500;
const MAX_CATALOGUE_EFFORTS = 500;
const MAX_CODEX_PAGES = 10;
// eslint-disable-next-line no-control-regex -- ANSI output uses the escape byte.
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

export type DeviceCatalogueStatus =
  | "ready"
  | "default-only"
  | "stale"
  | "unavailable"
  | "unsupported";

export type DeviceCatalogueReason =
  | "not-refreshed"
  | "executable-missing"
  | "command-failed"
  | "configuration-invalid"
  | "timed-out"
  | "invalid-output"
  | "catalogue-unsupported"
  | "harness-unsupported";

export interface DeviceEffortOption {
  name: string;
  description: string | null;
  default: boolean;
}

export interface DeviceModelEntry {
  name: string;
  /** The launcher-reported canonical id, or null when none was reported. */
  resolvedModel: string | null;
  label: string;
  description: string | null;
  default: boolean;
  efforts: readonly DeviceEffortOption[];
}

export interface DeviceCatalogue {
  /** The registered launcher that produced this catalogue. */
  launcher: string;
  /** The harness implemented by the launcher. */
  harness: string;
  /** The launcher revision used for discovery. */
  revision: number;
  status: DeviceCatalogueStatus;
  models: readonly DeviceModelEntry[];
  /** Null means the executable has not been checked. */
  executableAvailable: boolean | null;
  checkedAt: string | null;
  fetchedAt: string | null;
  freshUntil: string | null;
  error: string | null;
}

export interface DeviceCatalogueSnapshot {
  catalogues: readonly DeviceCatalogue[];
}

export interface DeviceLauncher {
  name: string;
  harness: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  revision: number;
}

export interface CommandResult {
  status: "ok" | "unavailable" | "failed" | "configuration-invalid" | "timed-out";
  stdout: string;
}

export type FixedCommandRunner = (
  argv: readonly string[],
  timeoutMs: number,
  env?: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

export type AdapterStatus =
  | "ok"
  | "unavailable"
  | "failed"
  | "timed-out"
  | "configuration-invalid"
  | "unsupported"
  | "invalid-output";

export interface AdapterResult {
  status: AdapterStatus;
  models: readonly DeviceModelEntry[];
}

export type CatalogueAdapter = (launcher: DeviceLauncher) => Promise<AdapterResult>;
export type CodexCatalogueRunner = CatalogueAdapter;

export interface CodexCataloguePage {
  models: readonly DeviceModelEntry[];
  nextCursor: string | null;
}

export type SelectionResolution =
  | { ok: true; argvSuffix: readonly string[] }
  | { ok: false; field: "model" | "effort"; reason: string };

/** Options accepted by the SDK query factory used by the Claude adapter. */
export interface ClaudeQueryOptions {
  prompt: AsyncIterable<unknown>;
  options: {
    pathToClaudeCodeExecutable: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
    settingSources: readonly ["user", "project", "local"];
    persistSession: false;
    tools: readonly [];
  };
}

export interface ClaudeQuery {
  supportedModels(): Promise<unknown>;
  close(): void;
}

export type ClaudeQueryFactory = (options: ClaudeQueryOptions) => ClaudeQuery;

export interface DeviceModelCatalogueOptions {
  now?: () => number;
  commandRunner?: FixedCommandRunner;
  claudeRunner?: CatalogueAdapter;
  claudeQueryFactory?: ClaudeQueryFactory;
  codexRunner?: CodexCatalogueRunner;
  piRunner?: CatalogueAdapter;
  opencodeRunner?: CatalogueAdapter;
  executableAvailable?: (binary: string) => boolean;
  ttlMs?: number;
}

interface CatalogueState {
  launcher: string;
  harness: string;
  launcherRevision: number;
  fingerprint: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  status: DeviceCatalogueStatus;
  models: readonly DeviceModelEntry[];
  executableAvailable: boolean | null;
  checkedAt: number | null;
  fetchedAt: number | null;
  freshUntil: number | null;
  reason: DeviceCatalogueReason | null;
}

const SUPPORTED_HARNESSES = new Set(["claude", "codex", "opencode", "pi"]);

function launcherFingerprint(launcher: DeviceLauncher): string {
  return JSON.stringify([launcher.harness, launcher.argv, launcher.env, launcher.revision]);
}

function initialState(launcher: DeviceLauncher): CatalogueState {
  const supported = SUPPORTED_HARNESSES.has(launcher.harness);
  return {
    launcher: launcher.name,
    harness: launcher.harness,
    launcherRevision: launcher.revision,
    fingerprint: launcherFingerprint(launcher),
    argv: launcher.argv,
    env: { ...launcher.env },
    status: supported ? "unavailable" : "unsupported",
    models: [],
    executableAvailable: null,
    checkedAt: null,
    fetchedAt: null,
    freshUntil: null,
    reason: supported ? "not-refreshed" : "harness-unsupported",
  };
}

function cleanOutput(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && validModelIdentifier(value, "model").isOk();
}

function validDescription(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validResolvedModel(value: unknown): value is string | null {
  return value === null || validModelId(value);
}

function validObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyPrompt(): AsyncIterable<unknown> {
  return (async function* (): AsyncGenerator<never, void, unknown> {
    yield* [];
  })();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("catalogue command timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseAdapterFailure(status: AdapterStatus): DeviceCatalogueReason {
  switch (status) {
    case "unavailable": return "executable-missing";
    case "timed-out": return "timed-out";
    case "configuration-invalid": return "configuration-invalid";
    case "invalid-output": return "invalid-output";
    case "unsupported": return "catalogue-unsupported";
    case "failed": return "command-failed";
    case "ok": return "invalid-output";
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
): Promise<{ text: string; exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_OUTPUT_BYTES) {
      await reader.cancel();
      return { text: "", exceeded: true };
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), exceeded: false };
}

function available(binary: string): boolean {
  try {
    return Bun.which(binary) !== null;
  } catch {
    return false;
  }
}

function resolveExecutable(binary: string): string | null {
  try {
    const found = Bun.which(binary);
    if (found === null) return null;
    return isAbsolute(found) ? found : resolve(found);
  } catch {
    return null;
  }
}

function effectiveEnvironment(launcher: DeviceLauncher): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  Object.assign(environment, launcher.env ?? {});
  return environment;
}

/** Runs one fixed adapter command. Request values never reach this function. */
export async function runFixedCommand(
  argv: readonly string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
  env?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const binary = argv[0];
  if (binary === undefined || !available(binary)) return { status: "unavailable", stdout: "" };
  try {
    const child = Bun.spawn({
      cmd: [...argv],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(env === undefined ? {} : { env: { ...env } }),
      timeout: timeoutMs,
    });
    const [stdout, stderr] = await Promise.all([readLimited(child.stdout), readLimited(child.stderr)]);
    await child.exited;
    if (child.signalCode !== null) return { status: "timed-out", stdout: "" };
    if (stdout.exceeded || stderr.exceeded) return { status: "failed", stdout: "" };
    if (child.exitCode !== 0) {
      const diagnostic = `${stderr.text}\n${stdout.text}`;
      const invalidConfiguration =
        /(?:config(?:uration)?\b.*\b(?:invalid|error|failed|malformed)|(?:invalid|malformed)\b.*\bconfig(?:uration)?|unrecognized key|unknown key|schema validation)/iu.test(diagnostic);
      return { status: invalidConfiguration ? "configuration-invalid" : "failed", stdout: "" };
    }
    return { status: "ok", stdout: stdout.text };
  } catch {
    return { status: "failed", stdout: "" };
  }
}

interface JsonLineReader {
  nextResponse(id: number): Promise<Record<string, unknown> | null>;
}

function jsonLineReader(stream: ReadableStream<Uint8Array>): JsonLineReader {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const pending = new Map<number, Record<string, unknown>>();
  let buffered = "";
  let bytes = 0;
  return {
    async nextResponse(id: number): Promise<Record<string, unknown> | null> {
      const saved = pending.get(id);
      if (saved !== undefined) {
        pending.delete(id);
        return saved;
      }
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.length === 0) continue;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (!validObject(parsed)) return null;
            const responseId = parsed.id;
            if (typeof responseId !== "number" || !Number.isInteger(responseId)) continue;
            if (responseId === id) return parsed;
            pending.set(responseId, parsed);
          } catch {
            return null;
          }
          continue;
        }
        const next = await reader.read();
        if (next.done) return null;
        bytes += next.value.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) {
          await reader.cancel();
          return null;
        }
        buffered += decoder.decode(next.value, { stream: true });
      }
    },
  };
}

function rpcPayload(response: Record<string, unknown>, command: string): Record<string, unknown> | null {
  if (response.type !== "response" || response.command !== command || response.success !== true) return null;
  return validObject(response.data) ? response.data : null;
}

function rpcSucceeded(response: Record<string, unknown>, command: string): boolean {
  return response.type === "response" && response.command === command && response.success === true;
}

function rpcModel(value: unknown): { provider: string; id: string } | null {
  if (!validObject(value)) return null;
  if (!validModelId(value.provider) || !validModelId(value.id)) return null;
  return { provider: value.provider, id: value.id };
}

function parseThinkingLevels(value: Record<string, unknown>): readonly string[] | null {
  const raw = value.levels;
  if (!Array.isArray(raw) || raw.length > MAX_CATALOGUE_EFFORTS) return null;
  const names = new Set<string>();
  const levels: string[] = [];
  for (const level of raw) {
    if (!validModelId(level) || names.has(level)) return null;
    names.add(level);
    levels.push(level);
  }
  return levels;
}

function piRows(
  models: readonly Record<string, unknown>[],
  initialModel: { provider: string; id: string } | null,
  initialThinking: string | null,
  levelsByModel: ReadonlyMap<string, readonly string[]>,
): readonly DeviceModelEntry[] | null {
  if (models.length === 0 || models.length > MAX_CATALOGUE_MODELS) return null;
  const seen = new Set<string>();
  const rows: DeviceModelEntry[] = [];
  for (const model of models) {
    const identity = rpcModel(model);
    if (identity === null) return null;
    const name = `${identity.provider}/${identity.id}`;
    if (!validModelId(name) || seen.has(name)) return null;
    const label = model.name;
    if (typeof label !== "string" || label.length === 0) return null;
    const levels = levelsByModel.get(name);
    if (levels === undefined) return null;
    const initialName = initialModel === null
      ? null
      : `${initialModel.provider}/${initialModel.id}`;
    const efforts = levels.map((level) => ({
      name: level,
      description: null,
      default: name === initialName && initialThinking === level,
    }));
    const description = model.description === undefined
      ? null
      : validDescription(model.description)
        ? model.description
        : null;
    if (model.description !== undefined && !validDescription(model.description)) return null;
    rows.push({
      name,
      resolvedModel: null,
      label,
      description,
      default: name === initialName,
      efforts,
    });
    seen.add(name);
  }
  return rows;
}

/** Decodes a Pi JSONL fixture after the RPC responses have been collected. */
export function decodePiCatalogue(
  stateResponse: unknown,
  modelsResponse: unknown,
  thinkingResponses: readonly unknown[],
): readonly DeviceModelEntry[] | null {
  if (!validObject(stateResponse) || !validObject(modelsResponse)) return null;
  const state = rpcPayload(stateResponse, "get_state");
  const availableModels = rpcPayload(modelsResponse, "get_available_models");
  if (state === null || availableModels === null || !Array.isArray(availableModels.models)) return null;
  const initialModel = rpcModel(state.model);
  if (initialModel === null) return null;
  const initialThinking = state.thinkingLevel === undefined
    ? null
    : typeof state.thinkingLevel === "string" && validModelId(state.thinkingLevel)
      ? state.thinkingLevel
      : null;
  if (state.thinkingLevel !== undefined && initialThinking === null) return null;
  if (thinkingResponses.length !== availableModels.models.length) return null;
  const levelsByModel = new Map<string, readonly string[]>();
  const modelRows: Record<string, unknown>[] = [];
  for (const rawModel of availableModels.models) {
    if (!validObject(rawModel)) return null;
    modelRows.push(rawModel);
  }
  for (let index = 0; index < modelRows.length; index += 1) {
    const identity = rpcModel(modelRows[index]);
    if (identity === null) return null;
    const response = thinkingResponses[index];
    if (!validObject(response)) return null;
    const payload = rpcPayload(response, "get_available_thinking_levels");
    if (payload === null) return null;
    const levels = parseThinkingLevels(payload);
    if (levels === null) return null;
    levelsByModel.set(`${identity.provider}/${identity.id}`, levels);
  }
  const rows = piRows(modelRows, initialModel, initialThinking, levelsByModel);
  if (rows === null || !rows.some((row) => row.default)) return null;
  return rows;
}

/** Compatibility parser name. Pi discovery requires correlated RPC responses. */
export function parsePiCatalogue(_modelsOutput: string, _helpOutput = ""): readonly DeviceModelEntry[] {
  const responses: Record<string, unknown>[] = [];
  for (const line of _modelsOutput.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!validObject(parsed)) return [];
      responses.push(parsed);
    } catch {
      return [];
    }
  }
  const stateResponse = responses[0];
  const modelsResponse = responses[1];
  if (stateResponse === undefined || modelsResponse === undefined) return [];
  const thinkingResponses = responses.slice(2).filter(
    (response) => response.command === "get_available_thinking_levels",
  );
  return decodePiCatalogue(stateResponse, modelsResponse, thinkingResponses) ?? [];
}

/** Reads Pi's JSONL RPC catalogue. It never sends a prompt. */
export async function runPiCatalogue(launcher: DeviceLauncher): Promise<AdapterResult> {
  const executable = launcher.argv[0];
  if (executable === undefined || !available(executable)) return { status: "unavailable", models: [] };
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stderrRead: Promise<{ text: string; exceeded: boolean }> | null = null;
  try {
    child = Bun.spawn({
      cmd: [
        ...launcher.argv,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...effectiveEnvironment(launcher) },
      timeout: COMMAND_TIMEOUT_MS,
    });
    stderrRead = readLimited(child.stderr);
    const lines = jsonLineReader(child.stdout);
    const write = async (message: Record<string, unknown>): Promise<void> => {
      child!.stdin.write(`${JSON.stringify(message)}\n`);
      await child!.stdin.flush();
    };
    await Promise.all([
      write({ id: 1, type: "get_state" }),
      write({ id: 2, type: "get_available_models" }),
    ]);
    const stateResponse = await lines.nextResponse(1);
    const modelsResponse = await lines.nextResponse(2);
    if (stateResponse === null || modelsResponse === null) {
      return { status: child.signalCode !== null ? "timed-out" : "invalid-output", models: [] };
    }
    const modelsPayload = rpcPayload(modelsResponse, "get_available_models");
    if (modelsPayload === null || !Array.isArray(modelsPayload.models)) {
      return { status: "invalid-output", models: [] };
    }
    if (modelsPayload.models.length === 0 || modelsPayload.models.length > MAX_CATALOGUE_MODELS) {
      return { status: "invalid-output", models: [] };
    }
    const thinkingResponses: Record<string, unknown>[] = [];
    let nextId = 3;
    for (const rawModel of modelsPayload.models) {
      const identity = rpcModel(rawModel);
      if (identity === null) return { status: "invalid-output", models: [] };
      await write({
        id: nextId,
        type: "set_model",
        provider: identity.provider,
        modelId: identity.id,
      });
      const setResponse = await lines.nextResponse(nextId);
      if (setResponse === null || !rpcSucceeded(setResponse, "set_model")) {
        return { status: child.signalCode !== null ? "timed-out" : "invalid-output", models: [] };
      }
      nextId += 1;
      await write({ id: nextId, type: "get_available_thinking_levels" });
      const levelResponse = await lines.nextResponse(nextId);
      if (levelResponse === null) {
        return { status: child.signalCode !== null ? "timed-out" : "invalid-output", models: [] };
      }
      thinkingResponses.push(levelResponse);
      nextId += 1;
    }
    const models = decodePiCatalogue(stateResponse, modelsResponse, thinkingResponses);
    if (models === null) return { status: "invalid-output", models: [] };
    return { status: "ok", models };
  } catch {
    return {
      status: child !== null && child.signalCode !== null ? "timed-out" : "failed",
      models: [],
    };
  } finally {
    if (child !== null) {
      try {
        child.stdin.end();
      } catch {
        // The process may have closed stdin after a protocol failure.
      }
      try {
        child.kill();
      } catch {
        // The process may have exited before cleanup.
      }
      await child.exited.catch(() => undefined);
    }
    await stderrRead?.catch(() => undefined);
  }
}

function jsonObjectAt(lines: readonly string[], start: number): { value: unknown; next: number } | null {
  let text = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) return null;
    text += `${line}\n`;
    for (const character of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    if (depth < 0) return null;
    if (depth === 0) {
      try {
        return { value: JSON.parse(text), next: index + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function decodeOpenCodeObject(heading: string, value: unknown): DeviceModelEntry | null {
  if (!validObject(value)) return null;
  const slash = heading.indexOf("/");
  if (slash <= 0 || slash === heading.length - 1) return null;
  const provider = heading.slice(0, slash);
  const id = heading.slice(slash + 1);
  if (!validModelId(provider) || !validModelId(id)) return null;
  if (
    value.id !== id ||
    value.providerID !== provider ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.status !== "active" ||
    !validObject(value.capabilities) ||
    !validObject(value.variants)
  ) return null;
  const efforts: DeviceEffortOption[] = [];
  const names = new Set<string>();
  for (const [name, rawVariant] of Object.entries(value.variants)) {
    if (!validModelId(name) || !validObject(rawVariant)) {
      return null;
    }
    if (rawVariant.disabled !== undefined && typeof rawVariant.disabled !== "boolean") return null;
    if (names.has(name)) return null;
    names.add(name);
    if (rawVariant.disabled) continue;
    efforts.push({ name, description: null, default: false });
  }
  const reportedResolved = value.resolvedModel;
  if (reportedResolved !== undefined && !validResolvedModel(reportedResolved)) return null;
  return {
    name: heading,
    resolvedModel: typeof reportedResolved === "string" && reportedResolved !== heading
      ? reportedResolved
      : null,
    label: value.name,
    description: null,
    default: false,
    efforts,
  };
}

/** Decodes OpenCode's repeated `provider/model` heading plus JSON format. */
export function decodeOpenCodeCatalogue(stdout: string): readonly DeviceModelEntry[] | null {
  const lines = cleanOutput(stdout).split(/\r?\n/u);
  const rows: DeviceModelEntry[] = [];
  const names = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    index += 1;
    if (line.length === 0) continue;
    if (!line.includes("/") || !validModelId(line)) continue;
    let jsonStart = index;
    while (jsonStart < lines.length && (lines[jsonStart]?.trim() ?? "").length === 0) jsonStart += 1;
    if (jsonStart >= lines.length) return null;
    const jsonLine = lines[jsonStart]?.trim() ?? "";
    if (!jsonLine.startsWith("{")) return null;
    const decoded = jsonObjectAt(lines, jsonStart);
    if (decoded === null) return null;
    index = decoded.next;
    const row = decodeOpenCodeObject(line, decoded.value);
    if (row === null || names.has(row.name)) return null;
    names.add(row.name);
    rows.push(row);
    if (rows.length > MAX_CATALOGUE_MODELS) return null;
  }
  return rows.length === 0 ? null : rows;
}

/** Public parser name retained for callers that already use adapter parsers. */
export function parseOpenCodeCatalogue(stdout: string): readonly DeviceModelEntry[] {
  return decodeOpenCodeCatalogue(stdout) ?? [];
}

/** Runs OpenCode with only the registered launcher argv and fixed discovery args. */
export async function runOpenCodeCatalogue(
  launcher: DeviceLauncher,
  commandRunner: FixedCommandRunner = runFixedCommand,
): Promise<AdapterResult> {
  const result = await commandRunner(
    [...launcher.argv, "models", "--verbose"],
    COMMAND_TIMEOUT_MS,
    effectiveEnvironment(launcher),
  );
  if (result.status !== "ok") return { status: result.status, models: [] };
  const models = decodeOpenCodeCatalogue(result.stdout);
  return models === null ? { status: "invalid-output", models: [] } : { status: "ok", models };
}

function decodeClaudeModels(value: unknown): readonly DeviceModelEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CATALOGUE_MODELS) return null;
  const names = new Set<string>();
  const rows: DeviceModelEntry[] = [];
  let defaults = 0;
  for (const raw of value) {
    if (!validObject(raw)) return null;
    if (
      !validModelId(raw.value) ||
      typeof raw.displayName !== "string" ||
      raw.displayName.length === 0 ||
      typeof raw.description !== "string" ||
      (raw.resolvedModel !== undefined && !validResolvedModel(raw.resolvedModel)) ||
      (raw.supportsEffort !== undefined && typeof raw.supportsEffort !== "boolean") ||
      (raw.supportedEffortLevels !== undefined && !Array.isArray(raw.supportedEffortLevels))
    ) return null;
    if (names.has(raw.value)) return null;
    names.add(raw.value);
    const levels = raw.supportedEffortLevels ?? [];
    if (raw.supportsEffort === false && levels.length > 0) return null;
    if (levels.length > MAX_CATALOGUE_EFFORTS) return null;
    const effortNames = new Set<string>();
    const efforts: DeviceEffortOption[] = [];
    for (const level of levels) {
      if (!validModelId(level) || effortNames.has(level)) return null;
      effortNames.add(level);
      efforts.push({ name: level, description: null, default: false });
    }
    const isDefault = raw.value === "default";
    if (isDefault) defaults += 1;
    rows.push({
      name: raw.value,
      resolvedModel: raw.resolvedModel ?? null,
      label: raw.displayName,
      description: raw.description,
      default: isDefault,
      efforts,
    });
  }
  return defaults > 1 ? null : rows;
}

export function decodeClaudeCatalogue(value: unknown): readonly DeviceModelEntry[] | null {
  return decodeClaudeModels(value);
}

/** Deprecated parser alias. Claude discovery uses SDK model rows, not CLI help. */
export function parseClaudeDefault(stdout: string): DeviceModelEntry {
  const parsed = decodeClaudeModels(JSON.parse(stdout) as unknown);
  const row = parsed?.find((candidate) => candidate.name === "default");
  if (row === undefined) throw new Error("Claude output did not contain a default model row");
  return row;
}

async function defaultClaudeQueryFactory(options: ClaudeQueryOptions): Promise<ClaudeQuery> {
  const module = await import("@anthropic-ai/claude-agent-sdk") as unknown as {
    query: (params: unknown) => ClaudeQuery;
  };
  return module.query(options as unknown);
}

/** Reads Claude's SDK model catalogue with an empty streaming input. */
export async function runClaudeCatalogue(
  launcher: DeviceLauncher,
  queryFactory?: ClaudeQueryFactory,
): Promise<AdapterResult> {
  const executable = launcher.argv[0];
  if (executable === undefined) return { status: "unavailable", models: [] };
  if (launcher.argv.length > 1) return { status: "unsupported", models: [] };
  const resolvedExecutable = resolveExecutable(executable);
  if (resolvedExecutable === null) return { status: "unavailable", models: [] };
  let query: ClaudeQuery | null = null;
  try {
    const factory = queryFactory ?? ((options: ClaudeQueryOptions) => {
      let pending: ClaudeQuery | null = null;
      const lazy = {
        supportedModels: async (): Promise<unknown> => {
          pending = await defaultClaudeQueryFactory(options);
          return pending.supportedModels();
        },
        close: (): void => pending?.close(),
      } satisfies ClaudeQuery;
      return lazy;
    });
    query = factory({
      prompt: emptyPrompt(),
      options: {
        pathToClaudeCodeExecutable: resolvedExecutable,
        cwd: process.cwd(),
        env: effectiveEnvironment(launcher),
        settingSources: ["user", "project", "local"],
        persistSession: false,
        tools: [],
      },
    });
    const models = await withTimeout(query.supportedModels(), COMMAND_TIMEOUT_MS);
    const decoded = decodeClaudeModels(models);
    return decoded === null ? { status: "invalid-output", models: [] } : { status: "ok", models: decoded };
  } catch (error) {
    return error instanceof Error && error.message.includes("timed out")
      ? { status: "timed-out", models: [] }
      : { status: "failed", models: [] };
  } finally {
    try {
      query?.close();
    } catch {
      // The SDK query may already have closed after a protocol failure.
    }
  }
}

function validCatalogueModels(models: readonly DeviceModelEntry[]): boolean {
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_CATALOGUE_MODELS) return false;
  const names = new Set<string>();
  let defaultModels = 0;
  for (const model of models) {
    if (!validObject(model) || !Array.isArray(model.efforts)) return false;
    if (
      !validModelId(model.name) ||
      names.has(model.name) ||
      typeof model.label !== "string" ||
      model.label.length === 0 ||
      !validResolvedModel(model.resolvedModel) ||
      !validDescription(model.description) ||
      typeof model.default !== "boolean" ||
      model.efforts.length > MAX_CATALOGUE_EFFORTS
    ) return false;
    names.add(model.name);
    if (model.default) defaultModels += 1;
    const effortNames = new Set<string>();
    let defaultEfforts = 0;
    for (const effort of model.efforts) {
      if (!validObject(effort)) return false;
      if (
        !validModelId(effort.name) ||
        effortNames.has(effort.name) ||
        !validDescription(effort.description) ||
        typeof effort.default !== "boolean"
      ) return false;
      effortNames.add(effort.name);
      if (effort.default) defaultEfforts += 1;
    }
    if (defaultEfforts > 1) return false;
  }
  return defaultModels <= 1;
}

/** Decodes one Codex `model/list` response without exposing raw protocol text. */
export function decodeCodexModelList(response: unknown): CodexCataloguePage | null {
  if (!validObject(response)) return null;
  const result = response.result ?? (Object.hasOwn(response, "data") ? response : undefined);
  if (!validObject(result)) return null;
  const data = result.data;
  const cursor = result.nextCursor;
  if (!Array.isArray(data) || !(cursor === undefined || cursor === null || typeof cursor === "string")) return null;
  const models: DeviceModelEntry[] = [];
  const modelNames = new Set<string>();
  for (const raw of data) {
    if (!validObject(raw)) return null;
    if (
      !validModelId(raw.id) ||
      modelNames.has(raw.id) ||
      typeof raw.displayName !== "string" ||
      raw.displayName.length === 0 ||
      !validDescription(raw.description) ||
      typeof raw.isDefault !== "boolean" ||
      typeof raw.defaultReasoningEffort !== "string" ||
      !validModelId(raw.defaultReasoningEffort) ||
      !Array.isArray(raw.supportedReasoningEfforts)
    ) return null;
    const efforts: DeviceEffortOption[] = [];
    const effortNames = new Set<string>();
    for (const rawEffort of raw.supportedReasoningEfforts) {
      if (!validObject(rawEffort)) return null;
      if (
        !validModelId(rawEffort.reasoningEffort) ||
        effortNames.has(rawEffort.reasoningEffort) ||
        !validDescription(rawEffort.description)
      ) return null;
      effortNames.add(rawEffort.reasoningEffort);
      efforts.push({
        name: rawEffort.reasoningEffort,
        description: rawEffort.description,
        default: rawEffort.reasoningEffort === raw.defaultReasoningEffort,
      });
    }
    if (!effortNames.has(raw.defaultReasoningEffort)) return null;
    const resolved = raw.resolvedModel;
    if (resolved !== undefined && !validResolvedModel(resolved)) return null;
    modelNames.add(raw.id);
    models.push({
      name: raw.id,
      resolvedModel: typeof resolved === "string" && resolved !== raw.id ? resolved : null,
      label: raw.displayName,
      description: raw.description,
      default: raw.isDefault,
      efforts,
    });
  }
  return { models, nextCursor: typeof cursor === "string" ? cursor : null };
}

/** Alias retained for adapter callers. */
export const parseCodexCataloguePage = decodeCodexModelList;
export const parseCodexCatalogue = decodeCodexModelList;

/** Reads Codex's supported app-server protocol from the registered launcher. */
export async function runCodexCatalogue(launcher: DeviceLauncher): Promise<AdapterResult> {
  const executable = launcher.argv[0];
  if (executable === undefined || !available(executable)) return { status: "unavailable", models: [] };
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stderrRead: Promise<{ text: string; exceeded: boolean }> | null = null;
  try {
    child = Bun.spawn({
      cmd: [...launcher.argv, "app-server", "--stdio"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...effectiveEnvironment(launcher) },
      timeout: COMMAND_TIMEOUT_MS,
    });
    stderrRead = readLimited(child.stderr);
    const lines = jsonLineReader(child.stdout);
    const write = async (message: Record<string, unknown>): Promise<void> => {
      child!.stdin.write(`${JSON.stringify(message)}\n`);
      await child!.stdin.flush();
    };
    await write({ id: 1, method: "initialize", params: { clientInfo: { name: "sheppard", version: "0.1.0" } } });
    const initialized = await lines.nextResponse(1);
    if (initialized === null || !validObject(initialized.result)) {
      return { status: child.signalCode !== null ? "timed-out" : "invalid-output", models: [] };
    }
    await write({ method: "initialized" });
    const models: DeviceModelEntry[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < MAX_CODEX_PAGES; page += 1) {
      const id = page + 2;
      await write({ id, method: "model/list", params: { includeHidden: false, cursor, limit: 100 } });
      const response = await lines.nextResponse(id);
      if (response === null) {
        return { status: child.signalCode !== null ? "timed-out" : "invalid-output", models: [] };
      }
      const decoded = decodeCodexModelList(response);
      if (decoded === null) return { status: "invalid-output", models: [] };
      models.push(...decoded.models);
      if (models.length > MAX_CATALOGUE_MODELS) return { status: "invalid-output", models: [] };
      cursor = decoded.nextCursor;
      if (cursor === null) break;
      if (cursors.has(cursor)) return { status: "invalid-output", models: [] };
      cursors.add(cursor);
    }
    if (cursor !== null || !validCatalogueModels(models)) return { status: "invalid-output", models: [] };
    return { status: "ok", models };
  } catch {
    return {
      status: child !== null && child.signalCode !== null ? "timed-out" : "failed",
      models: [],
    };
  } finally {
    if (child !== null) {
      try {
        child.stdin.end();
      } catch {
        // The process may have closed stdin after a protocol failure.
      }
      try {
        child.kill();
      } catch {
        // The process may have exited before cleanup.
      }
      await child.exited.catch(() => undefined);
    }
    await stderrRead?.catch(() => undefined);
  }
}

function visible(state: CatalogueState, now: number): DeviceCatalogue {
  const expired =
    (state.status === "ready" || state.status === "default-only") &&
    state.freshUntil !== null && state.freshUntil <= now;
  return {
    launcher: state.launcher,
    harness: state.harness,
    revision: state.launcherRevision,
    status: expired ? "stale" : state.status,
    models: state.models,
    executableAvailable: state.executableAvailable,
    checkedAt: state.checkedAt === null ? null : new Date(state.checkedAt).toISOString(),
    fetchedAt: state.fetchedAt === null ? null : new Date(state.fetchedAt).toISOString(),
    freshUntil: state.freshUntil === null ? null : new Date(state.freshUntil).toISOString(),
    error: catalogueError(expired ? (state.reason ?? "not-refreshed") : state.reason),
  };
}

function catalogueError(reason: DeviceCatalogueReason | null): string | null {
  switch (reason) {
    case null: return null;
    case "not-refreshed": return "The launcher catalogue has not been refreshed.";
    case "executable-missing": return "The launcher's executable is not available.";
    case "command-failed": return "The launcher catalogue command failed.";
    case "configuration-invalid": return "The launcher configuration is invalid.";
    case "timed-out": return "The launcher catalogue timed out.";
    case "invalid-output": return "The launcher returned invalid catalogue data.";
    case "catalogue-unsupported": return "The launcher does not report a model catalogue.";
    case "harness-unsupported": return "This launcher has no device catalogue adapter.";
  }
}

function failState(state: CatalogueState, now: number, reason: DeviceCatalogueReason): void {
  state.checkedAt = now;
  state.reason = reason;
  state.status = state.fetchedAt === null ? "unavailable" : "stale";
}

function adapterFailure(state: CatalogueState, now: number, result: AdapterResult): void {
  if (result.status === "ok") {
    failState(state, now, "invalid-output");
    return;
  }
  failState(state, now, parseAdapterFailure(result.status));
}

export class DeviceModelCatalogue {
  private readonly now: () => number;
  private readonly commandRunner: FixedCommandRunner;
  private readonly claudeRunner: CatalogueAdapter;
  private readonly codexRunner: CodexCatalogueRunner;
  private readonly piRunner: CatalogueAdapter;
  private readonly opencodeRunner: CatalogueAdapter;
  private readonly executableAvailable: (binary: string) => boolean;
  private readonly ttlMs: number;
  private readonly states = new Map<string, CatalogueState>();

  constructor(options: DeviceModelCatalogueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.commandRunner = options.commandRunner ?? runFixedCommand;
    this.claudeRunner = options.claudeRunner ?? ((launcher) => runClaudeCatalogue(launcher, options.claudeQueryFactory));
    this.codexRunner = options.codexRunner ?? runCodexCatalogue;
    this.piRunner = options.piRunner ?? runPiCatalogue;
    this.opencodeRunner = options.opencodeRunner ?? ((launcher) => runOpenCodeCatalogue(launcher, this.commandRunner));
    this.executableAvailable = options.executableAvailable ?? available;
    this.ttlMs = options.ttlMs ?? CATALOGUE_TTL_MS;
  }

  supportsHarness(harness: string): boolean {
    return SUPPORTED_HARNESSES.has(harness);
  }

  supportsLauncher(launcher: DeviceLauncher): boolean {
    switch (launcher.harness) {
      case "claude": return launcher.argv.length === 1;
      case "codex":
      case "pi":
      case "opencode": return true;
      default: return false;
    }
  }

  private stateFor(launcher: DeviceLauncher): CatalogueState {
    const fingerprint = launcherFingerprint(launcher);
    const previous = this.states.get(launcher.name);
    if (
      previous !== undefined &&
      previous.fingerprint === fingerprint &&
      previous.harness === launcher.harness
    ) return previous;
    const next = initialState(launcher);
    this.states.set(launcher.name, next);
    return next;
  }

  private statesFor(launchers: readonly DeviceLauncher[]): CatalogueState[] {
    const ordered = [...launchers].toSorted((left, right) => left.name.localeCompare(right.name));
    return ordered.map((launcher) => this.stateFor(launcher));
  }

  snapshot(launchers: readonly DeviceLauncher[]): DeviceCatalogueSnapshot {
    return { catalogues: this.statesFor(launchers).map((state) => visible(state, this.now())) };
  }

  async refresh(
    launchers: readonly DeviceLauncher[],
    target?: string,
  ): Promise<DeviceCatalogueSnapshot> {
    const states = this.statesFor(launchers).filter((state) => target === undefined || state.launcher === target);
    for (const state of states) await this.refreshOne(state);
    return this.snapshot(launchers);
  }

  hasCurrentCatalogue(launcher: DeviceLauncher): boolean {
    const state = this.stateFor(launcher);
    const current = visible(state, this.now());
    return current.status === "ready" || current.status === "default-only";
  }

  resolveSelection(
    launcher: DeviceLauncher,
    modelName: string | null,
    effortName: string | null,
  ): SelectionResolution {
    if (modelName === null && effortName === null) return { ok: true, argvSuffix: [] };
    const state = this.stateFor(launcher);
    const current = visible(state, this.now());
    if (current.status !== "ready" && current.status !== "default-only") {
      return { ok: false, field: "model", reason: "device catalogue is not current" };
    }
    const model = modelName === null
      ? current.models.find((entry) => entry.default)
      : current.models.find((entry) => entry.name === modelName);
    if (model === undefined) {
      return { ok: false, field: "model", reason: "is not available for this launcher on this device" };
    }
    const effort = effortName === null ? null : model.efforts.find((entry) => entry.name === effortName) ?? null;
    if (effortName !== null && effort === null) {
      return { ok: false, field: "effort", reason: "is not available for the selected model" };
    }
    switch (state.harness) {
      case "codex":
        return {
          ok: true,
          argvSuffix: [
            ...(modelName === null ? [] : ["-m", model.name]),
            ...(effort === null ? [] : ["-c", `model_reasoning_effort="${effort.name}"`]),
          ],
        };
      case "pi":
        return {
          ok: true,
          argvSuffix: [
            ...(modelName === null ? [] : ["--model", model.name]),
            ...(effort === null ? [] : ["--thinking", effort.name]),
          ],
        };
      case "opencode":
        return {
          ok: true,
          argvSuffix: modelName === null
            ? []
            : ["--model", effort === null ? model.name : `${model.name}#${effort.name}`],
        };
      case "claude":
        return {
          ok: true,
          argvSuffix: [
            ...(model.name === "default" ? [] : ["--model", model.name]),
            ...(effort === null ? [] : ["--effort", effort.name]),
          ],
        };
    }
  }

  private async refreshOne(state: CatalogueState): Promise<void> {
    const now = this.now();
    state.checkedAt = now;
    if (!SUPPORTED_HARNESSES.has(state.harness)) {
      state.status = "unsupported";
      state.models = [];
      state.executableAvailable = false;
      state.fetchedAt = null;
      state.freshUntil = null;
      state.reason = "harness-unsupported";
      return;
    }
    state.executableAvailable = this.executableAvailable(state.argv[0] ?? "");
    if (!state.executableAvailable) {
      failState(state, now, "executable-missing");
      return;
    }
    const launcher: DeviceLauncher = {
      name: state.launcher,
      harness: state.harness,
      argv: state.argv,
      env: state.env,
      revision: state.launcherRevision,
    };
    const result = await this.adapterFor(state.harness)(launcher);
    if (result.status !== "ok" || !validCatalogueModels(result.models)) {
      adapterFailure(state, now, result.status === "ok" ? { ...result, status: "invalid-output" } : result);
      return;
    }
    state.status = "ready";
    state.models = result.models;
    state.fetchedAt = now;
    state.freshUntil = now + this.ttlMs;
    state.reason = null;
  }

  private adapterFor(harness: string): CatalogueAdapter {
    switch (harness) {
      case "claude": return this.claudeRunner;
      case "codex": return this.codexRunner;
      case "pi": return this.piRunner;
      case "opencode": return this.opencodeRunner;
      default: return async () => ({ status: "invalid-output", models: [] });
    }
  }
}
