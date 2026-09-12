# Third-party notices

`dsh-rtk` is MIT licensed (see [LICENSE](LICENSE)). It is a derivative of an
MIT-licensed project, whose notice is reproduced below as that license requires.

---

## pi-rtk-optimizer

Copyright (c) 2026 MasuRii

Licensed under the MIT License.

Derived from <https://github.com/MasuRii/pi-rtk-optimizer>, version 0.9.0.

What came from it: the decision to delegate rewriting to `rtk rewrite` instead of
maintaining a rule table; rtk's exit-code contract (`0`/`3` carry a rewrite on
stdout, `1` means no equivalent, `2` means rtk refused); the runtime guard that
runs the original command when rtk is unavailable; the output-compaction pipeline
and each of its techniques (ANSI stripping, build filtering, test aggregation, git
compaction, linter aggregation, search grouping, source filtering, and both
truncation stages); the documented default of every configuration field; and the
`/rtk` command surface.

What did not: the seam it hooks (Pi's `tool_call`/`tool_result` events rather than
this harness's `tools/execute` and `tools/post-execute`), the TUI settings modal,
streamed-output sanitization, and the Windows-specific shell fixups. Each is
recorded under "Differences from pi-rtk-optimizer" in [README.md](README.md), and
[docs/verification.md](docs/verification.md) holds this port's acceptance evidence.

---

## MIT License, as it applies to the project above

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
