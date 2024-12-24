import * as vscode from "vscode";
import { CodeObjectReader, ResolvedSymbol } from "./symbolization.js";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { EOL } from "node:os";
import { output } from "./logs.js";

const execFile = promisify(execFileCb);

/**
 * Reads code objects using an addr2line-style symbolizer.
 */
export class GNUBinutilsCodeObjectReader implements CodeObjectReader {
    constructor(
        public readonly name = "GNU Binutils",
        /**
         * The name or path of the executable to spawn.
         */
        public readonly executable = "addr2line",
    ) {}

    async isWorking(): Promise<boolean> {
        output.appendLine(
            `Checking addr2line named ${this.name} (${this.executable})`,
        );
        try {
            await execFile(this.executable, ["--version"]);
            return true;
        } catch {
            return false;
        }
    }

    async resolveToSymbolInObject(
        address: string,
        codeObject: vscode.Uri,
    ): Promise<ResolvedSymbol> {
        const args = ["-f", "-C", "-e", codeObject.fsPath, "--", address];
        output.appendLine(
            `Using ${this.name} install to resolve symbol: ${
                this.executable
            } ${args.join(" ")}`,
        );
        const { stdout } = await execFile(this.executable, args);

        const [symbolName, location] = stdout.trim().split(EOL);
        const lineNumberSplit = location.lastIndexOf(":");

        const path = location.substring(0, lineNumberSplit);
        const lineNum = Number.parseInt(
            location.substring(lineNumberSplit + 1),
        );
        const position = new vscode.Position(lineNum - 1, 0);

        return {
            uri: vscode.Uri.file(path),
            position,
            symbolName,
            codeObject,
        };
    }
}

export class PROSToolchainCodeObjectReader extends GNUBinutilsCodeObjectReader {
    static #getOperatingSystem() {
        if (process.platform === "win32") {
            return "windows";
        }
        if (process.platform === "darwin") {
            return "macos";
        }
        return "linux";
    }

    constructor(globalStorageUri: vscode.Uri) {
        const system = PROSToolchainCodeObjectReader.#getOperatingSystem();

        let toolchainUri = vscode.Uri.joinPath(
            globalStorageUri,
            `sigbots.pros/install/pros-toolchain-${system}`,
        );
        if (system === "windows") {
            toolchainUri = vscode.Uri.joinPath(toolchainUri, "usr");
        }

        const addr2lineUri = vscode.Uri.joinPath(
            toolchainUri,
            "bin/arm-none-eabi-addr2line",
        );

        super("PROS Toolchain", addr2lineUri.fsPath);
    }
}

export class LLVMCodeObjectReader implements CodeObjectReader {
    constructor(
        public readonly name = "LLVM",
        public readonly executable = "llvm-symbolizer",
    ) {}

    async isWorking(): Promise<boolean> {
        output.appendLine(
            `Checking llvm-symbolizer named ${this.name} (${this.executable})`,
        );
        try {
            await execFile(this.executable, ["--version"]);
            return true;
        } catch {
            return false;
        }
    }

    async resolveToSymbolInObject(
        address: string,
        codeObject: vscode.Uri,
    ): Promise<ResolvedSymbol> {
        const args = ["--output-style=JSON", "-e", codeObject.fsPath, address];
        output.appendLine(
            `Using ${this.name} install to resolve symbol: ${
                this.executable
            } ${args.join(" ")}`,
        );
        const { stdout } = await execFile(this.executable, args);

        const entry = JSON.parse(stdout)[0] as LLVMSymbolizerEntry;
        if (!entry) {
            throw new Error("No symbolizer entry for this address");
        }
        const symbol = entry.Symbol[0];
        if (!symbol) {
            throw new Error("No symbol data for this address");
        }
        if (!symbol.FileName) {
            throw new Error("The symbol does not exist");
        }

        const position = new vscode.Position(
            symbol.Line - 1,
            symbol.Column - 1,
        );

        return {
            uri: vscode.Uri.file(symbol.FileName),
            position,
            symbolName: symbol.FunctionName,
            codeObject,
        };
    }
}

interface LLVMSymbolizerEntry {
    Address: string;
    ModuleName: string;
    Symbol: LLVMSymbolizerSymbol[];
}

interface LLVMSymbolizerSymbol {
    Column: number;
    Discriminator: number;
    FileName: string;
    Line: number;
    StartAddress: string;
    StartFileName: string;
    StartLine: number;
    FunctionName: string;
}
