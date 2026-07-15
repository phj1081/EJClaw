import { closeSync, constants, fsyncSync, openSync, rmSync, writeSync } from "node:fs";

export async function writeBoundedResponse(response: Response, path: string, maxBytes: number): Promise<number> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`download exceeded ${maxBytes} bytes`);
  if (!response.body) throw new Error("download body missing");

  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`download exceeded ${maxBytes} bytes`);
      let offset = 0;
      while (offset < value.byteLength) {
        const written = writeSync(fd, value, offset, value.byteLength - offset);
        if (written <= 0) throw new Error("download write made no progress");
        offset += written;
      }
    }
    fsyncSync(fd);
    return total;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    rmSync(path, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
}
