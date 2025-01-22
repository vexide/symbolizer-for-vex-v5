#!/usr/bin/env zx

// Patches the llvm-symbolizer binary to not depend on Homebrew zstd.
// Run using: https://google.github.io/zx/getting-started
// Requires Homebrew zstd to be installed.

import path from "node:path";

$.verbose = true;

const inputPath = argv._[0] ?? (await question("Unpatched file? "));
const outputPath = argv._[1] ?? (await question("Output path? "));

const zstdHomebrew = "/opt/homebrew/opt/zstd/lib/libzstd.1.dylib";

if (!(await fs.pathExists(zstdHomebrew))) {
    await $`brew install zstd`;
}

console.log("Copying", inputPath, "to", outputPath);
await fs.copy(inputPath, outputPath);

const zstdDestination = path.resolve(
    outputPath,
    "..",
    path.basename(zstdHomebrew),
);
console.log("Copying", zstdHomebrew, "to", zstdDestination);
await fs.copy(zstdHomebrew, zstdDestination, {
    dereference: true,
});

// Edit the mach-o header to point to the bundled copy

// Search for dylibs in the executable's folder.
await $`/usr/bin/install_name_tool -add_rpath @executable_path/. ${outputPath}`;

// Use the dylib search path instead of hardcoding homebrew.
const bundledZstd = `@rpath/${path.basename(zstdHomebrew)}`;
await $`/usr/bin/install_name_tool -change ${zstdHomebrew} ${bundledZstd} ${outputPath}`;

// Print patched binary linkages for debugging
await $`/usr/bin/otool -L ${outputPath}`;
