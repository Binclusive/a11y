# Changelog

## [0.3.0](https://github.com/Binclusive/a11y/compare/v0.2.0...v0.3.0) (2026-07-08)


### Features

* **check-url:** join the unified output-format + gate seam ([#243](https://github.com/Binclusive/a11y/issues/243)) ([#260](https://github.com/Binclusive/a11y/issues/260)) ([661e54f](https://github.com/Binclusive/a11y/commit/661e54fb4b5deb45e04e8fa4178dcab7053dc7fd))
* **compose:** check_kotlin MCP tool + .kt editor-hook parity ([#117](https://github.com/Binclusive/a11y/issues/117)) ([#266](https://github.com/Binclusive/a11y/issues/266)) ([e185f03](https://github.com/Binclusive/a11y/commit/e185f03837e70ac5fd4e933d6ac53718bda265e0))
* **compose:** check-kotlin CLI verb + collect-kotlin boundary + compose provenance ([#114](https://github.com/Binclusive/a11y/issues/114)) ([#255](https://github.com/Binclusive/a11y/issues/255)) ([66584d5](https://github.com/Binclusive/a11y/commit/66584d56080905e3a653a505a3e08dc8a4b1cdec))
* **compose:** compose-matrix corpus regression gate + blessed baseline ([#118](https://github.com/Binclusive/a11y/issues/118)) ([#259](https://github.com/Binclusive/a11y/issues/259)) ([e334bbd](https://github.com/Binclusive/a11y/commit/e334bbd761e793974cae3e95e545e465480e5b8f))
* **detect-stack:** recognize Jetpack Compose Kotlin projects + route ([#113](https://github.com/Binclusive/a11y/issues/113)) ([#262](https://github.com/Binclusive/a11y/issues/262)) ([01a3435](https://github.com/Binclusive/a11y/commit/01a3435169da6fa96a4f094125d3ed77ccf3bf05))
* **enforce:** first-run with no binclusive.json is advisory, not block-all ([#184](https://github.com/Binclusive/a11y/issues/184)) ([#250](https://github.com/Binclusive/a11y/issues/250)) ([9dcf4bb](https://github.com/Binclusive/a11y/commit/9dcf4bb9b10ae77d05e579048849416d50ba4f55))
* **mcp:** emit the canonical a11y contract from checkUrl ([#216](https://github.com/Binclusive/a11y/issues/216)) ([#254](https://github.com/Binclusive/a11y/issues/254)) ([593d891](https://github.com/Binclusive/a11y/commit/593d891bbf04733ca5e0a17fb70da237a49c221b))
* **reporter:** Buildkite annotation adapter behind the reporter seam ([#212](https://github.com/Binclusive/a11y/issues/212)) ([#252](https://github.com/Binclusive/a11y/issues/252)) ([86bee91](https://github.com/Binclusive/a11y/commit/86bee9149b4a8a01218d5be8e100effb4bad2c42))
* **reporter:** GitLab MR-note adapter behind the reporter seam ([#213](https://github.com/Binclusive/a11y/issues/213)) ([#244](https://github.com/Binclusive/a11y/issues/244)) ([252cc71](https://github.com/Binclusive/a11y/commit/252cc719f729d6b6621180d3cfd7ce9d5b9f30ec))


### Bug Fixes

* **ci:** rename-proof the SwiftPM cache key in swift.yml ([#299](https://github.com/Binclusive/a11y/issues/299)) ([#302](https://github.com/Binclusive/a11y/issues/302)) ([0456635](https://github.com/Binclusive/a11y/commit/04566357d960cff6102c898b442bf1b937a9e747))
* **cli:** make a failed URL render distinguishable from a clean pass ([#218](https://github.com/Binclusive/a11y/issues/218)) ([#242](https://github.com/Binclusive/a11y/issues/242)) ([118009b](https://github.com/Binclusive/a11y/commit/118009b828435cc9f2345a97d89bfa280e5265e8))
* **enforce:** route icon-only raw intrinsic &lt;button&gt; through the name-check ([#257](https://github.com/Binclusive/a11y/issues/257)) ([#264](https://github.com/Binclusive/a11y/issues/264)) ([06ac312](https://github.com/Binclusive/a11y/commit/06ac31286f928bc2b21237d68a2cc3a7f50ba2f4))
* **evidence:** cite each finding's OWN deque rule, not the SC-first ref ([#192](https://github.com/Binclusive/a11y/issues/192)) ([#246](https://github.com/Binclusive/a11y/issues/246)) ([80445cf](https://github.com/Binclusive/a11y/commit/80445cfbcbecd43a8c3933db37ccea5824694a2e))
* **reporter:** fall back instead of swallowing 422 for out-of-hunk inline comments ([#207](https://github.com/Binclusive/a11y/issues/207)) ([#241](https://github.com/Binclusive/a11y/issues/241)) ([58b214d](https://github.com/Binclusive/a11y/commit/58b214d10d9ee8cb50d971a19580ed513c5dfa2e))

## [0.2.0](https://github.com/Binclusive/a11y/compare/v0.1.4...v0.2.0) (2026-07-08)


### Features

* **compose:** A11yKotlinScan engine + compose/image-no-label rule ([#112](https://github.com/Binclusive/a11y/issues/112)) ([#235](https://github.com/Binclusive/a11y/issues/235)) ([f01a36e](https://github.com/Binclusive/a11y/commit/f01a36edc39e7471da7c17cd1b96845d5da94a0d))


### Bug Fixes

* **sarif:** anchor relatedLocations on a physicalLocation for GitHub code-scanning ([#239](https://github.com/Binclusive/a11y/issues/239)) ([548208c](https://github.com/Binclusive/a11y/commit/548208cc357a8079cff571dc6ce05dc5239ad83d)), closes [#238](https://github.com/Binclusive/a11y/issues/238)

## [0.1.4](https://github.com/Binclusive/a11y/compare/v0.1.3...v0.1.4) (2026-07-07)


### Bug Fixes

* **cli:** single-source CLI/MCP version from package.json + auto-bump plugin.json ([#175](https://github.com/Binclusive/a11y/issues/175)) ([#233](https://github.com/Binclusive/a11y/issues/233)) ([62f7ced](https://github.com/Binclusive/a11y/commit/62f7ced447738ee995a8ac9404a6bd86b347c1ed))

## [0.1.3](https://github.com/Binclusive/a11y/compare/v0.1.2...v0.1.3) (2026-07-07)


### Bug Fixes

* **test:** correct finding-voice import path (corpus→evidence) ([#208](https://github.com/Binclusive/a11y/issues/208)) ([9c00ebe](https://github.com/Binclusive/a11y/commit/9c00ebe9606d05e2d44444028b102b7f075688b4)), closes [#172](https://github.com/Binclusive/a11y/issues/172)
* **test:** exclude nested .claude/worktrees from vitest collection ([#209](https://github.com/Binclusive/a11y/issues/209)) ([a8a0253](https://github.com/Binclusive/a11y/commit/a8a025343708909a042fc4457036465773c403da)), closes [#98](https://github.com/Binclusive/a11y/issues/98)
* **test:** pin axe-core so the baseline catalog resolves deterministically ([#211](https://github.com/Binclusive/a11y/issues/211)) ([f288bd0](https://github.com/Binclusive/a11y/commit/f288bd0ffacaf5c7c25af34b917e50d38bb2275d))
