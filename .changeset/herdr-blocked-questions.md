---
"@hank-warren/pi-ask-user-question": patch
"@hank-warren/pi-plan-mode": patch
---

Report a waiting question to Herdr as `blocked`.

`ask_user_question` and Plan Mode's `plan_mode_question` now emit the same
`herdr:blocked` event pi-auto-permissions emits for an approval prompt, labelled
`question` / `plan question` and cleared in a `finally`, so Herdr's pi
integration shows a session waiting on a question as `blocked` rather than
`working`. A supervising agent in another pane can wait on that state and answer
the dialog. No-op outside Herdr.
