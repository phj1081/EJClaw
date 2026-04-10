import fs from 'fs';
import path from 'path';

export function shouldClose(closeSentinelPath: string): boolean {
  if (fs.existsSync(closeSentinelPath)) {
    try {
      fs.unlinkSync(closeSentinelPath);
    } catch {
      // Ignore cleanup errors on shutdown signal files.
    }
    return true;
  }
  return false;
}

export function drainIpcInput(
  inputDir: string,
  log: (message: string) => void,
): string[] {
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const files = fs
      .readdirSync(inputDir)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(inputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore best-effort cleanup failures.
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
