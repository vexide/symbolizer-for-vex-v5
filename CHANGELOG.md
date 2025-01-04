# Change Log

All notable changes to the "symbolizer-for-vex-v5" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Improved reliability of addr2line-based symbolization.

## [0.1.3]

- Improved the stability of the LLVM backend when jumping to symbols with missing file paths/line numbers.
  Now, the symbol's name will always be displayed, even if there is no source code to show for it. This makes
  it easier to work with closed-source VEXcode components. This feature was already working with the GNU Binutils
  backend.
- Symbols with missing file paths/line numbers no longer show "??" where the path would be.
- Command display names are now prefixed with the extension name.

## [0.1.2]

- Added links to wiki in README.md.

## [0.1.1]

- Drastically reduces extension bundle size by removing unnecessary files.

## [0.1.0]

- Initial release

[Unreleased]: https://github.com/doinkythederp/symbolizer-for-vex-v5/compare/v0.1.3...main
[0.1.3]: https://github.com/doinkythederp/symbolizer-for-vex-v5/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/doinkythederp/symbolizer-for-vex-v5/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/doinkythederp/symbolizer-for-vex-v5/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/doinkythederp/symbolizer-for-vex-v5/commits/v0.1.0
