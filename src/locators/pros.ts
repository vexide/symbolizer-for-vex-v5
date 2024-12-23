import * as vscode from "vscode";
import { CodeObjectLocator } from "../symbolization.js";
import { output } from "../logs.js";

interface TimestampedFile {
    uri: vscode.Uri;
    timestamp: number;
}

export class PROSCodeObjectLocator implements CodeObjectLocator {
    readonly name = "PROS Project";

    async findObjectUris(folder: vscode.Uri): Promise<vscode.Uri[]> {
        if (!PROSCodeObjectLocator.isPROSProject(folder)) {
            throw new Error("The specified folder is not a PROS project.");
        }

        const objects = await Promise.all(
            [
                "./bin/hot.package.elf",
                "./bin/cold.package.elf",
                "./bin/monolith.elf",
            ]
                .map((path) => vscode.Uri.joinPath(folder, path))
                .map(PROSCodeObjectLocator.getCodeObjectAt),
        );

        return objects
            .filter((obj) => obj !== undefined)
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((obj) => obj.uri);
    }

    static async isPROSProject(uri: vscode.Uri): Promise<boolean> {
        const projectFile = vscode.Uri.joinPath(uri, "./project.pros");
        try {
            await vscode.workspace.fs.stat(projectFile);
            output.appendLine(
                "This is definitely a PROS project because there's a `project.pros` file.",
            );
            return true;
        } catch {
            output.appendLine(
                "This isn't a PROS project because there's no `project.pros` file.",
            );
            return false;
        }
    }

    static async getCodeObjectAt(
        uri: vscode.Uri,
    ): Promise<TimestampedFile | undefined> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            output.appendLine(
                `This PROS project has a code object at "${uri}".`,
            );
            return {
                uri,
                timestamp: stat.mtime,
            };
        } catch {
            return;
        }
    }
}
