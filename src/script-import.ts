import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parseArguments, serializeArguments } from "./core/arguments.mjs";
import { executionPlatform, isAbsoluteExecutionPath } from "./core/execution-paths.mjs";

export type ScriptDraft = {
	source: string;
	extension: string;
	interpreter: string;
	args: string;
	cwd: string;
};

function invalidImport(): never {
	throw Object.assign(new Error("Script import needs correction."), { diagnosticCode: "INVALID_SETTINGS" });
}

/** Only plaintext and literal launch configuration cross this untrusted boundary. */
export function parseScriptDraft(input: unknown): ScriptDraft {
	if (!input || typeof input !== "object" || Array.isArray(input)) return invalidImport();
	const value = input as Record<string, unknown>;
	if (Object.keys(value).some(key => !["source", "extension", "interpreter", "args", "cwd"].includes(key))) return invalidImport();
	if (typeof value.source !== "string" || !value.source.trim() || value.source.includes("\0")
		|| Buffer.byteLength(value.source, "utf8") > 131_072) return invalidImport();
	if (typeof value.extension !== "string" || !/^[a-z0-9]{1,12}$/.test(value.extension)) return invalidImport();
	const interpreter = value.interpreter ?? "";
	const cwd = value.cwd ?? "";
	const args = value.args ?? (interpreter ? "{{script}}" : "");
	if (typeof interpreter !== "string" || interpreter.length > 8192 || interpreter.includes("\0")
		|| (interpreter && !isAbsoluteExecutionPath(interpreter))) return invalidImport();
	if (typeof cwd !== "string" || cwd.length > 8192 || cwd.includes("\0")
		|| (cwd && !isAbsoluteExecutionPath(cwd))) return invalidImport();
	if (typeof args !== "string" || args.length > 32_768) return invalidImport();
	const argv = parseArguments(args, executionPlatform());
	if (argv.length > 256 || argv.some(arg => typeof arg !== "string"
		|| arg.length > 8192 || arg.includes("\0"))) return invalidImport();
	if (argv.filter(arg => arg === "{{script}}").length !== (interpreter ? 1 : 0)
		|| argv.some(arg => arg !== "{{script}}" && arg.includes("{{script}}"))) return invalidImport();
	return { source: value.source, extension: value.extension, interpreter, args, cwd };
}

/** Called only for a complete token-targeted callback. Names and storage locations are plugin-owned. */
export async function writeImportedScript(draft: ScriptDraft): Promise<{ executable: string; argsText: string; cwd: string }> {
	if (process.platform !== "darwin" && process.platform !== "win32") return invalidImport();
	if (process.platform === "win32" && !draft.interpreter) return invalidImport();
	const base = process.platform === "win32" ? process.env.LOCALAPPDATA
		: path.join(homedir(), "Library", "Application Support");
	if (!base || !isAbsoluteExecutionPath(base)) return invalidImport();
	await mkdir(base, { recursive: true });
	let directory = await realpath(base);
	for (const segment of ["git.renaudcerrato.deckforge", "scripts"]) {
		directory = path.join(directory, segment);
		try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) return invalidImport();
	}
	const filename = path.join(directory, `${randomUUID()}.${draft.extension}`);
	const file = await open(filename, "wx", 0o700);
	try { await file.writeFile(draft.source, "utf8"); } finally { await file.close(); }
	return {
		executable: draft.interpreter || filename,
		argsText: serializeArguments(parseArguments(draft.args, executionPlatform()).map(arg => arg === "{{script}}" ? filename : arg), executionPlatform()),
		cwd: draft.cwd,
	};
}
