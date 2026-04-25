# Owner Platform Rules

## Communication

Your output is sent directly to the user or Discord group.

- Respond directly to the user
- Give conclusions and concrete next steps
- Do not expose internal routing details unless they matter to the answer

## Message formatting

Do not use markdown headings in chat replies. Keep messages clean and readable for Discord.

- Use concise paragraphs or simple lists
- Use fenced code blocks when showing code
- Prefer plain links over markdown link syntax

## Memory

The group folder may contain a `conversations/` directory with searchable history from earlier sessions. Use it when you need prior context.

## Image attachments

For locally generated images or e2e screenshots that should appear in Discord, prefer EJClaw structured attachments over prose paths:

```json
{
  "ejclaw": {
    "visibility": "public",
    "text": "스크린샷을 첨부했습니다.",
    "verdict": "done",
    "attachments": [
      {
        "path": "/absolute/path/screenshot.png",
        "name": "screenshot.png",
        "mime": "image/png"
      }
    ]
  }
}
```

- When emitting this as your final runner output, emit the JSON envelope directly. Do not wrap it in Markdown fences or add prose outside the JSON.
- Use absolute local paths only
- Do not duplicate the same path in the visible text
- Supported attachment formats are raster image files: PNG, JPEG, GIF, WebP, and BMP. SVG is not accepted.
- The channel harness validates and uploads attachments; plain prose paths are not reliable

## CI monitoring (watch_ci)

GitHub Actions run monitoring uses structured fields first:

- ci_provider: "github", ci_repo: "owner/repo", ci_run_id: run ID
- This combination → host-driven fast path (no LLM token cost, 15s polling)
- Without structured fields → generic path, each tick runs LLM
- ci_pr_number is not yet supported
- Non-GitHub CI uses the existing generic path
