---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

Powered by gstack browse — persistent headless Chromium with ~100ms per command.

## Quick start

```bash
agent-browser goto <url>        # Navigate to page
agent-browser snapshot -i       # Get interactive elements with refs
agent-browser click @e1         # Click element by ref
agent-browser fill @e2 "text"   # Fill input by ref
```

## Core workflow

1. Navigate: `agent-browser goto <url>`
2. Snapshot: `agent-browser snapshot -i` (returns elements with refs like `@e1`, `@e2`)
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Commands

### Navigation

```bash
agent-browser goto <url>      # Navigate to URL
agent-browser back            # Go back
agent-browser forward         # Go forward
agent-browser reload          # Reload page
agent-browser url             # Get current URL
```

### Snapshot (page analysis)

```bash
agent-browser snapshot            # Full accessibility tree
agent-browser snapshot -i         # Interactive elements only (recommended)
agent-browser snapshot -c         # Compact output
agent-browser snapshot -d 3       # Limit depth to 3
agent-browser snapshot -s "#main" # Scope to CSS selector
agent-browser snapshot -D         # Diff against previous snapshot
agent-browser snapshot -a         # Annotated screenshot with ref labels
agent-browser snapshot -C         # Find non-ARIA clickable elements (@c refs)
```

### Interactions (use @refs from snapshot)

```bash
agent-browser click @e1           # Click
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter         # Press key
agent-browser hover @e1           # Hover
agent-browser select @e1 "value"  # Select dropdown option
agent-browser scroll down 500     # Scroll page
agent-browser upload @e1 file.pdf # Upload files
agent-browser viewport 1280x720  # Set viewport size
```

### Content extraction

```bash
agent-browser text                # Get all page text
agent-browser text @e1            # Get element text
agent-browser html @e1            # Get innerHTML
agent-browser links               # Get all links
agent-browser forms               # Get all forms
agent-browser accessibility       # Full accessibility tree
```

### Screenshots & PDF

```bash
agent-browser screenshot                    # Full page screenshot
agent-browser screenshot --viewport         # Viewport only
agent-browser screenshot @e1               # Element screenshot
agent-browser screenshot --clip x,y,w,h    # Region screenshot
agent-browser pdf output.pdf               # Save as PDF
agent-browser responsive                    # Multi-viewport screenshots
```

### Wait

```bash
agent-browser wait @e1                     # Wait for element
agent-browser wait 2000                    # Wait milliseconds
agent-browser wait --text "Success"        # Wait for text
agent-browser wait --url "**/dashboard"    # Wait for URL pattern
agent-browser wait --load networkidle      # Wait for network idle
```

### Inspection & Debugging

```bash
agent-browser js "document.title"          # Run JavaScript expression
agent-browser eval script.js               # Run JavaScript file
agent-browser css @e1 color                # Get CSS property
agent-browser attrs @e1                    # Get all attributes
agent-browser is visible @e1               # Check element state
agent-browser console                      # View console logs
agent-browser console --errors             # Console errors only
agent-browser network                      # View network requests
agent-browser perf                         # Performance metrics
```

### Cookies & Storage

```bash
agent-browser cookies                      # Get all cookies
agent-browser storage                      # Get localStorage
agent-browser storage set key value        # Set localStorage value
```

### Tabs

```bash
agent-browser tabs                         # List open tabs
agent-browser tab <id>                     # Switch to tab
agent-browser newtab <url>                 # Open new tab
agent-browser closetab                     # Close current tab
```

### Dialog handling

```bash
agent-browser dialog-accept               # Accept dialog (default behavior)
agent-browser dialog-accept "text"        # Accept prompt with text
agent-browser dialog-dismiss              # Dismiss dialog
```

### Compare

```bash
agent-browser diff <url1> <url2>          # Compare two pages
```

## Example: Form submission

```bash
agent-browser goto https://example.com/form
agent-browser snapshot -i
# Output: @e1 [textbox] "Email", @e2 [textbox] "Password", @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Example: Data extraction

```bash
agent-browser goto https://example.com/products
agent-browser snapshot -i
agent-browser text @e1            # Get product title
agent-browser screenshot items.png
```

## Notes

- Server auto-starts on first command, auto-shuts after 30min idle
- ~100ms per command after initial startup (~3s first time)
- Refs (`@e1`, `@e2`) are assigned from accessibility tree — re-snapshot after DOM changes
- `@c` refs from `-C` flag target non-ARIA clickable elements (divs with onclick, cursor:pointer)
