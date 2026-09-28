# @hank-warren/pi-thinking-step

## 0.1.0

### Minor Changes

- Initial release. `Alt+=` and `Alt+-` step the thinking level up or down one notch instead of cycling every level with `Shift+Tab`. Levels the current model does not support are skipped, and at the model's top or bottom level the shortcut stops and reports `(limit)` rather than wrapping. Steps are session-only; set a default from `/thinking` with `Ctrl+S`.
