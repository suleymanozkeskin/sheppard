import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Result } from "better-result";
import {
  type DictationUnavailable,
  type ValidationFailed,
  dictationUnavailable,
  validationFailed,
} from "./errors";

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u;
const HELPER_NAME = "sheppard-dictation";
const HELPER_APP_NAME = "Sheppard Dictation.app";
let helperPromise: Promise<Result<string, DictationUnavailable>> | undefined;

function failure(
  reason: DictationUnavailable["reason"],
  message: string,
): Result<never, DictationUnavailable> {
  return Result.err(dictationUnavailable(reason, message));
}

async function executable(path: string): Promise<boolean> {
  const checked = await Result.tryPromise<boolean, Error>({
    try: () => access(path, constants.X_OK).then(() => true),
    catch: (cause) => cause instanceof Error ? cause : new Error("Executable check failed"),
  });
  return checked.unwrapOr(false);
}

async function fileExists(path: string): Promise<boolean> {
  const checked = await Result.tryPromise<boolean, Error>({
    try: () => access(path).then(() => true),
    catch: (cause) => cause instanceof Error ? cause : new Error("File check failed"),
  });
  return checked.unwrapOr(false);
}

interface CommandOutput {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

async function runCommand(command: readonly string[], timeout: number): Promise<CommandOutput | null> {
  const spawned = Result.try({
    try: () => Bun.spawn({ cmd: [...command], stderr: "pipe", stdout: "pipe", timeout }),
    catch: () => null,
  });
  if (spawned.isErr() || spawned.value === null) return null;
  const child = spawned.value;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function compileHelper(databasePath: string): Promise<Result<string, DictationUnavailable>> {
  const bundledPath = join(
    dirname(process.execPath),
    HELPER_APP_NAME,
    "Contents",
    "MacOS",
    HELPER_NAME,
  );
  if (await executable(bundledPath)) return Result.ok(bundledPath);

  const xcrun = Bun.which("xcrun");
  if (xcrun === null) {
    return failure(
      "compile_failed",
      "Install the Xcode Command Line Tools to use local macOS dictation from this package.",
    );
  }

  const nativeRoot = join(import.meta.dir, "..", "native");
  const sourcePath = join(nativeRoot, "macos-dictation.m");
  const plistPath = join(nativeRoot, "macos-dictation.plist");
  const [sourceAvailable, plistAvailable] = await Promise.all([
    fileExists(sourcePath),
    fileExists(plistPath),
  ]);
  if (!sourceAvailable || !plistAvailable) {
    return failure("compile_failed", "The macOS dictation helper is missing from this Sheppard package.");
  }

  const cacheRoot = join(dirname(databasePath), "native");
  const appPath = join(cacheRoot, HELPER_APP_NAME);
  const contentsPath = join(appPath, "Contents");
  const helperPath = join(contentsPath, "MacOS", HELPER_NAME);
  if (await executable(helperPath)) return Result.ok(helperPath);
  await mkdir(join(contentsPath, "MacOS"), { recursive: true });
  await copyFile(plistPath, join(contentsPath, "Info.plist"));

  const compilation = await runCommand([
    xcrun,
    "clang",
    "-fobjc-arc",
    "-fblocks",
    "-framework",
    "Foundation",
    "-framework",
    "Speech",
    sourcePath,
    "-o",
    helperPath,
  ], 30_000);
  if (compilation === null || compilation.exitCode !== 0) {
    return failure("compile_failed", "The macOS dictation helper could not be prepared.");
  }

  await chmod(helperPath, 0o755);
  const codesign = Bun.which("codesign");
  if (codesign === null) {
    return failure("compile_failed", "The macOS dictation helper could not be signed.");
  }
  const signed = await runCommand([
    codesign,
    "--force",
    "--deep",
    "--sign",
    "-",
    "--identifier",
    "com.sheppard.dictation",
    appPath,
  ], 10_000);
  if (signed === null || signed.exitCode !== 0) {
    return failure("compile_failed", "The macOS dictation helper could not be prepared.");
  }
  return Result.ok(helperPath);
}

function helper(databasePath: string): Promise<Result<string, DictationUnavailable>> {
  helperPromise ??= compileHelper(databasePath);
  return helperPromise;
}

function hasWaveHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44) return false;
  const decoder = new TextDecoder("ascii");
  return decoder.decode(bytes.subarray(0, 4)) === "RIFF" &&
    decoder.decode(bytes.subarray(8, 12)) === "WAVE";
}

function messageForHelperFailure(code: string): DictationUnavailable {
  const [category] = code.split(":", 1);
  if (category === "recognition-failed" && code.includes("kLSRErrorDomain:201")) {
    return dictationUnavailable(
      "dictation_disabled",
      "Turn on Dictation in System Settings > Keyboard. If Voice Control is on, turn it off first.",
    );
  }
  switch (category) {
    case "permission-denied":
    case "permission-timeout":
      return dictationUnavailable(
        "permission_denied",
        "Allow Sheppard Dictation in System Settings > Privacy & Security > Speech Recognition.",
      );
    case "locale-unsupported":
      return dictationUnavailable("locale_unsupported", "macOS speech recognition does not support this language.");
    case "local-recognition-unavailable":
      return dictationUnavailable(
        "local_recognition_unavailable",
        "Download this Dictation language in System Settings, or select a supported macOS language.",
      );
    case "no-speech":
      return dictationUnavailable("no_speech", "No speech was detected.");
    case "recognition-timeout":
      return dictationUnavailable("timeout", "Dictation took too long to transcribe.");
    case "invalid-request":
    case "recognition-failed":
    default:
      return dictationUnavailable("recognition_failed", "macOS could not transcribe this recording.");
  }
}

async function removeTemporaryDirectory(path: string): Promise<void> {
  await Result.tryPromise<void, Error>({
    try: () => rm(path, { force: true, recursive: true }),
    catch: (cause) => cause instanceof Error ? cause : new Error("Temporary file cleanup failed"),
  });
}

export async function transcribeDictation(
  request: Request,
  databasePath: string,
): Promise<Result<{ transcript: string }, DictationUnavailable | ValidationFailed>> {
  if (process.platform !== "darwin") {
    return failure("unsupported_os", "Dictation is available on macOS only.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
    return Result.err(validationFailed("audio", "must be 12 MB or smaller"));
  }
  const localeHeader = request.headers.get("x-sheppard-dictation-locale") ?? "en-US";
  if (!LOCALE_PATTERN.test(localeHeader)) {
    return Result.err(validationFailed("locale", "must be a language tag"));
  }

  const body = await Result.tryPromise<ArrayBuffer, ValidationFailed>({
    try: () => request.arrayBuffer(),
    catch: () => validationFailed("audio", "could not be read"),
  });
  if (body.isErr()) return body;
  if (body.value.byteLength === 0 || body.value.byteLength > MAX_AUDIO_BYTES) {
    return Result.err(validationFailed("audio", "must contain at most 12 MB"));
  }
  const bytes = new Uint8Array(body.value);
  if (!hasWaveHeader(bytes)) return Result.err(validationFailed("audio", "must be a WAV recording"));

  const resolvedHelper = await helper(databasePath);
  if (resolvedHelper.isErr()) return resolvedHelper;
  const temporaryRootResult = await Result.tryPromise<string, DictationUnavailable>({
    try: () => mkdtemp(join(tmpdir(), "sheppard-dictation-")),
    catch: () => dictationUnavailable("recognition_failed", "Sheppard could not prepare the recording."),
  });
  if (temporaryRootResult.isErr()) return temporaryRootResult;

  const temporaryRoot = temporaryRootResult.value;
  const audioPath = join(temporaryRoot, "recording.wav");
  try {
    const stored = await Result.tryPromise<void, DictationUnavailable>({
      try: () => writeFile(audioPath, bytes),
      catch: () => dictationUnavailable("recognition_failed", "Sheppard could not prepare the recording."),
    });
    if (stored.isErr()) return stored;
    const result = await runCommand(
      [resolvedHelper.value, audioPath, localeHeader.replaceAll("_", "-")],
      90_000,
    );
    if (result === null) {
      return failure("recognition_failed", "macOS could not start local speech recognition.");
    }
    if (result.exitCode !== 0) return Result.err(messageForHelperFailure(result.stderr.trim()));
    const transcript = result.stdout.trim();
    return transcript.length === 0
      ? failure("no_speech", "No speech was detected.")
      : Result.ok({ transcript });
  } finally {
    await removeTemporaryDirectory(temporaryRoot);
  }
}
