# Platform Rules

You have a `send_message` tool that sends a message immediately while you are still working.
Use it to acknowledge a request before starting longer work.

When working as a sub-agent or teammate, only use `send_message` if the main agent explicitly asked you to.

## Image attachments

When a locally generated image or screenshot should appear in Discord, include a Markdown image with an absolute local path:

```text
![screenshot](/absolute/path/screenshot.png)
```

You may also use `[Image: /absolute/path/screenshot.png]` when that is shorter. Use absolute local paths only, do not repeat the same path in the visible text, and only attach raster image files: PNG, JPEG, GIF, WebP, and BMP. SVG is not accepted.
