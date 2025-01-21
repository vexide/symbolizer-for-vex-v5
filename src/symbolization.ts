import * as vscode from "vscode";
import { output } from "./logs.js";
import { inspect } from "node:util";
import * as path from "node:path";

/**
 * Locates code objects which contain useful metadata such that they can be used in symbolization.
 */
export interface CodeObjectLocator {
    /**
     * The name of the locator.
     */
    readonly name: string;

    /**
     * Finds URIs of code objects to use in symbolization.
     * @param folder the folder to check in
     */
    findObjectUris(folder: vscode.Uri): Promise<vscode.Uri[]>;
}

export interface ResolvedLocation {
    /**
     * The URI of the file in which the symbol is located.
     */
    uri: vscode.Uri;
    /**
     * The line number and column of the symbol.
     */
    position: vscode.Position;
}

/**
 * Metadata about an address such as its file and line number.
 */
export interface ResolvedSymbol {
    /**
     * The location in source code of the symbol.
     */
    sourceLocation?: ResolvedLocation;
    /**
     * The URI of the code object from which this metadata was read.
     */
    codeObject: vscode.Uri;
    /**
     * The human-readable name of this symbol.
     */
    symbolName: string;
}

/**
 * Reads metadata from a code object such as an ELF file.
 */
export interface CodeObjectReader {
    /**
     * The name of the reader.
     */
    readonly name: string;

    /**
     * Checks if the reader could be used to symbolize a code object.
     * @returns `true` if it is working, `false` if it isn't
     */
    isWorking(): Promise<boolean>;

    /**
     * Retrieves metadata from a code object to turn an address into a {@link ResolvedSymbol}.
     * @param address the address to symbolize
     * @param codeObject the code object to retrieve metadata from
     */
    resolveToSymbolInObject(
        address: string,
        codeObject: vscode.Uri,
    ): Promise<ResolvedSymbol>;
}

/**
 * Handles requests to symbolize address by searching for code objects and reading their metadata.
 */
export class Symbolizer {
    constructor(
        public locators: CodeObjectLocator[],
        public readers: CodeObjectReader[],
    ) {}

    #firstWorkingReader: CodeObjectReader | undefined = undefined;
    /**
     * Gets and caches the first code object reader which is working properly from the list of {@link readers}.
     * @returns the code object reader, or undefined if none are working
     */
    async getWorkingReader(): Promise<CodeObjectReader | undefined> {
        if (!this.#firstWorkingReader) {
            output.appendLine("Trying to find a working code object reader.");
            for (const reader of this.readers) {
                try {
                    if (await reader.isWorking()) {
                        this.#firstWorkingReader = reader;
                        output.appendLine(
                            `The following reader will be used: ${inspect(
                                reader,
                            )}`,
                        );
                        break;
                    }
                } catch {}
            }
        } else {
            if (!(await this.#firstWorkingReader.isWorking())) {
                output.appendLine(
                    "The current code reader has stopped working!",
                );
                this.#firstWorkingReader = undefined;
                return await this.getWorkingReader();
            }
        }

        return this.#firstWorkingReader;
    }

    /**
     * Gets the folder that the user is working in.
     * @returns the folder, or undefined if there is no active folder
     */
    getActiveFolder(): vscode.WorkspaceFolder | undefined {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri) {
            const activeWorkspace =
                vscode.workspace.getWorkspaceFolder(activeUri);
            if (activeWorkspace) {
                return activeWorkspace;
            }
        }
        return vscode.workspace.workspaceFolders?.[0];
    }

    /**
     * Resolves metadata about an address.
     * @param address the address to resolve
     * @param folder the folder to search for metadata in
     * @returns the metadata
     */
    async resolveToSymbol(
        address: string,
        folder: vscode.WorkspaceFolder,
    ): Promise<ResolvedSymbol> {
        const readerRequest = this.getWorkingReader();

        let locatedCodeObjects: vscode.Uri[] = [];
        for (const locator of this.locators) {
            output.appendLine(
                `Looking for code objects using "${locator.name}"`,
            );
            try {
                const found = await locator.findObjectUris(folder.uri);
                output.appendLine(
                    `The code object locator "${locator.name}" found ${found.length} objects.`,
                );
                if (found.length > 0) {
                    locatedCodeObjects.push(...found);
                    break;
                }
            } catch (err) {
                output.appendLine(
                    `The code object locator "${locator.name}" failed to find any objects: ${err}`,
                );
            }
        }

        if (locatedCodeObjects.length === 0) {
            throw new Error("Cannot find any code objects in this project");
        }

        output.appendLine(
            "The following code objects were found, in order of preference:",
        );
        let itemNum = 1;
        for (const codeObject of locatedCodeObjects) {
            output.appendLine(`    ${itemNum}. ${codeObject.fsPath}`);
            itemNum += 1;
        }

        const reader = await readerRequest;
        if (!reader) {
            const readers = this.readers
                .map((reader) => reader.name)
                .join(", ");
            throw new Error(
                `Cannot find any working code object readers; install one of: ${readers}`,
            );
        }

        const errors = [];
        let resolved: ResolvedSymbol | undefined;
        for (const codeObject of locatedCodeObjects) {
            output.appendLine(`Resolving ${codeObject.fsPath}`);
            try {
                resolved = await reader.resolveToSymbolInObject(
                    address,
                    codeObject,
                );
                output.appendLine(`Resolved to: ${inspect(resolved)}`);

                const resultIsSuboptimal =
                    resolved.sourceLocation === undefined;
                if (resultIsSuboptimal) {
                    output.appendLine(
                        "This result is sub-optimal because there is no source location, so any remaining objects will be checked as well.",
                    );
                } else {
                    output.appendLine(
                        "This result seems reasonable, stopping here.",
                    );
                    break;
                }
            } catch (err) {
                output.appendLine(
                    "This code object could not be resolved: " + inspect(err),
                );
                errors.push(err);
            }
        }

        if (!resolved) {
            throw new AggregateError(
                errors,
                "This address could not be resolved to a line",
            );
        }

        return resolved;
    }

    /**
     * Jumps to the file & line number on which the specified address is located.
     * @param address the address to jump to
     */
    async jumpToAddress(address: string): Promise<void> {
        output.appendLine(
            `Attempting to symbolize and jump to the address ${address}.`,
        );
        const folder = this.getActiveFolder();

        try {
            if (!folder) {
                throw new Error("There is no active workspace");
            }
            const resolved = await this.resolveToSymbol(address, folder);

            const ENABLE_DEBUG_INFO = "Enable all debug metadata (recommended)";
            const extraActions: string[] = [];

            const remoteRepos = this.#getRemoteRepos(resolved);
            let showFullPath = false;

            try {
                await this.#jumpToLine(resolved);
            } catch {
                // No need to clog up the info message with debug data if the user can just hit the button to open in their browser
                if (remoteRepos.size === 0) {
                    showFullPath = true;
                }
            }

            let sourceCodePath: string | undefined = undefined;
            if (resolved.sourceLocation) {
                sourceCodePath = showFullPath
                    ? resolved.sourceLocation.uri.path
                    : path.basename(resolved.sourceLocation.uri.path);
            }

            const codeObjectFileName = path.basename(resolved.codeObject.path);

            // If VEXcode's debug info is disabled, sometimes you can still get symbol names but not source locations.
            // If this is the case, offer to enable debug info.
            const shouldEnableDebugInfo =
                !resolved.sourceLocation &&
                (await this.canAutoFixVEXCodeDebugInfo(folder.uri));
            if (shouldEnableDebugInfo) {
                extraActions.push(ENABLE_DEBUG_INFO);
            }

            let msg = resolved.symbolName;
            if (sourceCodePath !== undefined) {
                msg += ` in ${sourceCodePath}`;
            }
            msg += ` (${codeObjectFileName})`;

            vscode.window
                .showInformationMessage(
                    msg,
                    ...extraActions,
                    ...remoteRepos.keys(),
                )
                .then((action) => {
                    if (!action) {
                        return;
                    }

                    tryAsyncOrLogError(async () => {
                        if (action === ENABLE_DEBUG_INFO) {
                            await this.autoFixVEXCodeDebugInfo(folder.uri);
                            return;
                        }

                        const uri = remoteRepos.get(action);
                        if (uri) {
                            await vscode.env.openExternal(uri);
                        }
                    });
                });
        } catch (err) {
            const RUN_AUTOFIX = "Enable debug metadata (auto-fix)";
            const DOWNLOAD_LLVM = "Download LLVM";
            const SHOW_PROS_EXTENSION =
                "Install PROS VS Code extension (recommended)";
            const INSTALL_PROS_TOOLCHAIN =
                "Install PROS Toolchain (recommended)";

            output.appendLine(`Failed to jump to line: ${inspect(err)}`);
            const msg = err instanceof Error ? err.message : String(err);

            const actions: string[] = [];

            if (
                msg.includes("This address could not be resolved to a line") &&
                folder &&
                (await this.canAutoFixVEXCodeDebugInfo(folder.uri))
            ) {
                actions.push(RUN_AUTOFIX);
            }

            if (msg.includes("Cannot find any working code object readers")) {
                if (vscode.extensions.getExtension("sigbots.pros")) {
                    actions.push(INSTALL_PROS_TOOLCHAIN);
                } else {
                    actions.push(SHOW_PROS_EXTENSION);
                }
                actions.push(DOWNLOAD_LLVM);
            }

            if (actions.length) {
                output.appendLine(
                    `Offering the following solutions: ${actions.join(", ")}`,
                );
            }

            vscode.window
                .showErrorMessage(`Couldn't jump to line: ${msg}`, ...actions)
                .then(async (action) => {
                    if (action === RUN_AUTOFIX) {
                        try {
                            await this.autoFixVEXCodeDebugInfo(folder!.uri);
                        } catch (err) {
                            vscode.window.showErrorMessage(
                                `Couldn't enable debug info: ${err}`,
                            );
                        }
                    } else if (action === DOWNLOAD_LLVM) {
                        vscode.env.openExternal(
                            vscode.Uri.parse(
                                "https://github.com/llvm/llvm-project/releases/latest",
                            ),
                        );
                    } else if (action === SHOW_PROS_EXTENSION) {
                        vscode.commands.executeCommand(
                            "workbench.extensions.search",
                            "sigbots.pros",
                        );
                    } else if (action === INSTALL_PROS_TOOLCHAIN) {
                        const pros =
                            vscode.extensions.getExtension("sigbots.pros");
                        if (pros) {
                            await pros.activate();
                            await vscode.commands.executeCommand(
                                "pros.install",
                            );
                            await this.jumpToAddress(address);
                        } else {
                            vscode.commands.executeCommand(
                                "workbench.extensions.search",
                                "sigbots.pros",
                            );
                        }
                    }
                });
        }
    }

    /**
     * Generates a map of names and their corresponding URIs for symbols which can only be viewed
     * online.
     * @param resolved the symbol to generate the map for
     * @returns the map
     */
    #getRemoteRepos(resolved: ResolvedSymbol): Map<string, vscode.Uri> {
        const repos = new Map();

        const prosBase = "/home/vsts/work/1/s/";
        if (resolved.sourceLocation?.uri.path.startsWith(prosBase)) {
            const relative = resolved.sourceLocation.uri.path.replace(
                prosBase,
                "",
            );
            const full = path.resolve(
                "purduesigbots/pros/blob/develop-pros-4/",
                relative,
            );

            repos.set(
                "Open purduesigbots/pros",
                vscode.Uri.from({
                    scheme: "https",
                    authority: "www.github.com",
                    path: full,
                    fragment: `L${resolved.sourceLocation.position.line + 1}`,
                }),
            );
        }

        return repos;
    }

    /**
     * Jumps to the line on which the specified symbol resides.
     * @param resolved the symbol to jump to
     */
    async #jumpToLine(resolved: ResolvedSymbol) {
        if (!resolved.sourceLocation) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(
            resolved.sourceLocation.uri,
        );
        await vscode.window.showTextDocument(document, {
            selection: new vscode.Range(
                resolved.sourceLocation.position,
                resolved.sourceLocation.position,
            ),
        });
    }

    async #readVEXCodeMakefile(projectDir: vscode.Uri) {
        const makefileBytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(projectDir, "makefile"),
        );
        return new TextDecoder().decode(makefileBytes);
    }

    readonly #vexCodeAutoFixDebugInfoInsertionPoint = "include vex/mkenv.mk";

    /**
     * Checks if debug info can be automatically enabled in the specified VEXCode project.
     * @param projectDir the VEXCode project to check
     * @param makefileContents the contents of the project's makefile, if it has already been read
     * @returns `true` if a fix is available, `false` otherwise
     */
    async canAutoFixVEXCodeDebugInfo(
        projectDir: vscode.Uri,
        makefileContents?: string,
    ) {
        try {
            const makefile =
                makefileContents ??
                (await this.#readVEXCodeMakefile(projectDir));

            // Needs to be a VEXCode makefile to apply auto-fix
            if (!makefile.startsWith("# VEXcode makefile")) {
                return false;
            }

            if (
                !makefile.includes(this.#vexCodeAutoFixDebugInfoInsertionPoint)
            ) {
                return false;
            }

            // If the fix has already been applied, then there's no reason to do it again.
            if (makefile.includes(" -g")) {
                return false;
            }

            output.appendLine("Offering to fix Makefile.");

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Automatically enables debug info in a VEXCode project so that symbols can be resolved.
     * @param projectDir the VEXCode project to fix
     */
    async autoFixVEXCodeDebugInfo(projectDir: vscode.Uri) {
        output.appendLine("Attempting to fix Makefile!");

        let makefile = await this.#readVEXCodeMakefile(projectDir);

        if (!(await this.canAutoFixVEXCodeDebugInfo(projectDir, makefile))) {
            output.appendLine(
                "Aborting — the Makefile is no longer in a fixable state. (Perhaps the fix was already run)",
            );
            return;
        }

        output.appendLine(`Makefile contents:\n\n${makefile}\n\n`);

        makefile = makefile.replace(
            this.#vexCodeAutoFixDebugInfoInsertionPoint,
            `${
                this.#vexCodeAutoFixDebugInfoInsertionPoint
            }\n\n# enable debug metadata\nCFLAGS += -g\nCXX_FLAGS += -g`,
        );

        output.appendLine(`NEW Makefile contents:\n\n${makefile}\n\n`);

        const bytes = new TextEncoder().encode(makefile);

        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(projectDir, "makefile"),
            bytes,
        );

        let didClean = false;

        try {
            await vscode.commands.executeCommand(
                "vexrobotics.vexcode.project.clean",
            );
            didClean = true;
        } catch {}

        vscode.window.showInformationMessage(
            `Enabled debug metadata! ${
                didClean
                    ? "Reupload your project"
                    : "Clean the project and reupload it"
            } to finish.`,
        );
    }
}

async function tryAsyncOrLogError<T>(
    fn: () => Thenable<T>,
): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`Error: ${msg}`);
        vscode.window.showErrorMessage(`Error: ${msg}`);

        return undefined;
    }
}
