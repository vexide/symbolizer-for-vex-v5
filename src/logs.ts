import { inspect } from "node:util";
import * as vscode from "vscode";

export const output = vscode.window.createOutputChannel(
    "Symbolizer for VEX V5",
);

export function inspectPattern(pattern: vscode.GlobPattern): string {
    if (typeof pattern === "string") {
        return `Pattern(${inspect(pattern)})`;
    }

    return `Pattern(${inspect(pattern.pattern)}, in ${inspect(
        pattern.baseUri.fsPath,
    )})`;
}
