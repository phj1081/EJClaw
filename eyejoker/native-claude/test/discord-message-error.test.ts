import { describe, expect, test } from "bun:test";
import { isUnknownDiscordMessage, resolveExistingDiscordMessage } from "../src/discord-message-error";

describe("Discord progress message recovery", () => {
  test("treats only Discord unknown-message code 10008 as authoritative absence", () => {
    expect(isUnknownDiscordMessage({ code: 10008, status: 404 })).toBe(true);
    expect(isUnknownDiscordMessage({ rawError: { code: 10008 }, status: 404 })).toBe(true);
    expect(isUnknownDiscordMessage({ code: 50001, status: 404 })).toBe(false);
    expect(isUnknownDiscordMessage({ status: 500 })).toBe(false);
  });

  test("returns null for a missing message but preserves transient fetch failures", async () => {
    const missing = await resolveExistingDiscordMessage(async () => {
      throw { code: 10008, status: 404 };
    });
    expect(missing).toBeNull();

    const transient = new Error("Discord 503");
    await expect(resolveExistingDiscordMessage(async () => {
      throw transient;
    })).rejects.toBe(transient);
  });
});