import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Homebrew's Pi executable is a shell launcher; npm installs point into dist/.
const executable = fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const sdkPath = [
	process.env.PI_SDK_PATH,
	path.join(path.dirname(executable), "index.js"),
	path.resolve(path.dirname(executable), "../libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
].find((file) => file && fs.existsSync(file));
assert(sdkPath, "Install pi-coding-agent or set PI_SDK_PATH to its dist/index.js.");
export const sdk = await import(pathToFileURL(sdkPath).href);
export const tui = await import(pathToFileURL(createRequire(sdkPath).resolve("@earendil-works/pi-tui")).href);
