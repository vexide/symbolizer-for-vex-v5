// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { ResolvedLine as ResolvedSymbol, Symbolizer } from "./symbolization.js";
import { output } from "./logs.js";
import * as path from "node:path";
import { PROSCodeObjectLocator } from "./locators/pros.js";
import {
    GNUBinutilsCodeObjectReader,
    LLVMCodeObjectReader,
    PROSToolchainCodeObjectReader,
} from "./readers.js";
import { format } from "node:util";
import { platform } from "node:process";

/**
 * A terminal link with an extra `address` field.
 */
class AddressLink extends vscode.TerminalLink {
    constructor(match: RegExpExecArray) {
        super(match.index, match[0].length);
        this.address = match[0];
    }

    /**
     * Stores the address that needs to be symbolized.
     */
    address: string;
}

/**
 * Finds clickable addresses and handles jumping to their source code.
 */
class AddressLinkProvider implements vscode.TerminalLinkProvider {
    /**
     * Checks whether an address is in user-space and therefore usable.
     * @param match the RegExp match containing the address
     * @returns `true` if the address is in user-space, `false` otherwise
     */
    static #isAddressInUserSpace(match: RegExpExecArray) {
        const number = Number.parseInt(match[0]);
        return number >= 0x3800000;
    }

    constructor(public symbolizer: Symbolizer) {}

    provideTerminalLinks(
        context: vscode.TerminalLinkContext,
        token: vscode.CancellationToken,
    ): vscode.ProviderResult<AddressLink[]> {
        // find 0x... addresses in the terminal so we can jump to them
        const matches = context.line.matchAll(/(?<=^\s+)0x[0-9a-fA-F]+$/g);

        const links = Array.from(matches)
            .filter(AddressLinkProvider.#isAddressInUserSpace)
            .map((match) => new AddressLink(match));

        for (const link of links) {
            output.appendLine(
                `The address "${link.address}" could possibly be symbolized.`,
            );
        }

        return links;
    }

    async handleTerminalLink(link: AddressLink): Promise<void> {
        output.appendLine(
            `Attempting to symbolize and jump to the address ${link.address}.`,
        );
        try {
            const resolved = await this.symbolizer.resolveToLine(link.address);
            output.appendLine(`Resolved to: ${format(resolved)}`);

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

            const sourceCodePath = showFullPath
                ? resolved.uri.path
                : path.basename(resolved.uri.path);
            const codeObjectFileName = path.basename(resolved.codeObject.path);

            vscode.window
                .showInformationMessage(
                    `${resolved.symbolName} in ${sourceCodePath} (${codeObjectFileName})`,
                    ...remoteRepos.keys(),
                )
                .then((action) => {
                    if (!action) {
                        return;
                    }

                    const uri = remoteRepos.get(action);
                    if (uri) {
                        vscode.env.openExternal(uri);
                    }
                });
        } catch (err) {
            output.appendLine(`Failed to jump to line: ${err}`);
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Couldn't jump to line: ${msg}`);
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
        if (resolved.uri.path.startsWith(prosBase)) {
            const relative = resolved.uri.path.replace(prosBase, "");
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
                    fragment: `L${resolved.position.line + 1}`,
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
        const document = await vscode.workspace.openTextDocument(resolved.uri);
        await vscode.window.showTextDocument(document, {
            selection: new vscode.Range(resolved.position, resolved.position),
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    output.appendLine("Extension has been activated!");

    const readers = [new LLVMCodeObjectReader()];

    if (platform === "darwin") {
        // We like LLVM more than GNU Binutils (because it gives us column numbers) so it's worth the extra
        // effort here of checking for a Homebrew install.
        // Linux package managers don't need their own CodeObjectReader instances because they usually put
        // their tools in the $PATH of all processes, whereas Homebrew only puts it in the $PATH of shells.
        readers.push(
            new LLVMCodeObjectReader(
                "Homebrew LLVM",
                "/opt/homebrew/opt/llvm/bin/llvm-symbolizer",
            ),
        );
    }

    readers.push(
        // "And this is where I'd put my VEXCode arm-none-eabi-addr2line...if I had one!"
        // VEXCode doesn't ship with a symbolizer.
        // The Rustup `llvm-tools` component also doesn't ship with a symbolizer.
        new PROSToolchainCodeObjectReader(
            vscode.Uri.joinPath(context.globalStorageUri, ".."),
        ),
        new GNUBinutilsCodeObjectReader(
            "ARM Embedded Toolchain",
            "arm-none-eabi-addr2line",
        ),
        new GNUBinutilsCodeObjectReader(),
    );

    const symbolizer = new Symbolizer([new PROSCodeObjectLocator()], readers);

    const linkDisposable = vscode.window.registerTerminalLinkProvider(
        new AddressLinkProvider(symbolizer),
    );

    context.subscriptions.push(linkDisposable);
}

export function deactivate() {
    output.appendLine("Extension has been deactivated.");
}
