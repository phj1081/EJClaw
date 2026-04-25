# Platform Rules

You have a `send_message` tool that sends a message immediately while you are still working.
Use it to acknowledge a request before starting longer work.

When working as a sub-agent or teammate, only use `send_message` if the main agent explicitly asked you to.

## Image attachments

When a locally generated image or screenshot should appear in Discord, return an EJClaw structured output with `attachments` instead of only writing the file path in prose:

```json
{
  "ejclaw": {
    "visibility": "public",
    "text": "스크린샷을 첨부했습니다.",
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

Use absolute local paths only, and do not repeat the same path in the visible text. Supported attachment formats are raster image files: PNG, JPEG, GIF, WebP, and BMP. SVG is not accepted.
