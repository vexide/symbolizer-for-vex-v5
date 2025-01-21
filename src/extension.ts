// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { CodeObjectReader, Symbolizer } from "./symbolization.js";
import { output } from "./logs.js";
import {
    SimpleFilesystemConvention,
    VexideFilesystemConvention,
    RecentCodeObjectLocator,
    VEXCodeFilesystemConvention,
} from "./locators.js";
import {
    GNUBinutilsCodeObjectReader,
    LLVMCodeObjectReader,
    PROSToolchainCodeObjectReader,
} from "./readers.js";
import { platform } from "node:process";

const ADDRESS_PATTERN = /(?<=^\s*\d*:?\s*)0x[0-9a-fA-F]+$/g;

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
        const matches = context.line.matchAll(ADDRESS_PATTERN);

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
        await this.symbolizer.jumpToAddress(link.address);
    }
}

export function activate(context: vscode.ExtensionContext) {
    output.appendLine("Extension has been activated!");

    const readers: CodeObjectReader[] = [new LLVMCodeObjectReader()];

    if (platform === "darwin") {
        // We like LLVM more than GNU Binutils (because it gives us column numbers) so it's worth the extra
        // effort here of checking for a Homebrew install.
        // Linux package managers don't need their own CodeObjectReader instances because they usually put
        // their tools in the $PATH of all processes, whereas Homebrew only puts it in the $PATH of shells.
        // readers.push(
        //     new LLVMCodeObjectReader(
        //         "Homebrew LLVM",
        //         "/opt/homebrew/opt/llvm/bin/llvm-symbolizer",
        //     ),
        // );
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

    const symbolizer = new Symbolizer(
        [
            new RecentCodeObjectLocator([
                new SimpleFilesystemConvention("PROS", [
                    "./bin/monolith.elf",
                    "./bin/hot.package.elf",
                    "./bin/cold.package.elf",
                ]),
                new VEXCodeFilesystemConvention(),
                new VexideFilesystemConvention(),
            ]),
        ],
        readers,
    );

    context.subscriptions.push(
        vscode.window.registerTerminalLinkProvider(
            new AddressLinkProvider(symbolizer),
        ),
        vscode.commands.registerCommand(
            "symbolizer-for-vex-v5.jump-to-address",
            async (addressParam: unknown) => {
                let address: string | undefined;

                if (typeof addressParam === "string") {
                    address = addressParam;
                } else {
                    address = await vscode.window.showInputBox({
                        title: "Jump to Address",
                        prompt: "Enter a hexadecimal address number to reveal its location in your source code.",
                        // This is just some random number that kind of looks like it'd work.
                        placeHolder: "03801a24",
                    });
                }

                if (!address) {
                    return;
                }

                if (!address.startsWith("0x")) {
                    address = `0x${address}`;
                }

                const matches = Array.from(address.matchAll(ADDRESS_PATTERN));
                if (matches.length === 0) {
                    vscode.window.showErrorMessage(
                        "The specified address must be a hexadecimal number.",
                    );
                    return;
                }

                await symbolizer.jumpToAddress(address);
            },
        ),
    );
}

export function deactivate() {
    output.appendLine("Extension has been deactivated.");
}
