# @hank-warren/pi-btw

## 0.1.0

### Minor Changes

- Initial release: `/btw <question>` asks a side question on top of the exact transcript of the session's last model request, so the provider serves the conversation from its prompt cache. The answer streams in yellow above the editor and lands in the transcript as a display-only card with the cached share of the prompt. The model never sees it, and the next prompt continues where the conversation was. Works while a turn is running; `/btw` alone cancels.
