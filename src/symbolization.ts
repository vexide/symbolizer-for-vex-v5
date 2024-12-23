import * as vscode from "vscode";
import { output } from "./logs.js";
import { format } from "node:util";

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

export interface ResolvedLine {
    uri: vscode.Uri;
    position: vscode.Position;
    codeObject: vscode.Uri;
    symbolName: string;
}

export interface CodeObjectReader {
    readonly name: string;

    isWorking(): Promise<boolean>;

    resolveToLineInObject(
        address: string,
        codeObject: vscode.Uri,
    ): Promise<ResolvedLine>;
}

export class Symbolizer {
    constructor(
        public locators: CodeObjectLocator[],
        public readers: CodeObjectReader[],
    ) {}

    #firstWorkingReader: CodeObjectReader | undefined = undefined;
    async getWorkingReader(): Promise<CodeObjectReader | undefined> {
        if (!this.#firstWorkingReader) {
            output.appendLine("Trying to find a working code object reader.");
            for (const reader of this.readers) {
                try {
                    if (await reader.isWorking()) {
                        this.#firstWorkingReader = reader;
                        output.appendLine(
                            `The following reader will be used: ${format(
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

    async resolveToLine(address: string) {
        const folder = this.getActiveFolder();
        if (!folder) {
            throw new Error("There is no active workspace");
        }

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
        let resolved: ResolvedLine | undefined;
        for (const codeObject of locatedCodeObjects) {
            try {
                resolved = await reader.resolveToLineInObject(
                    address,
                    codeObject,
                );
                break;
            } catch (err) {
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
}
