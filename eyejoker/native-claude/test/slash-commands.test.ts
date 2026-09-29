import { describe, expect, it } from "bun:test";
import { buildSlashCommands, handleSlashCommand } from "../src/slash-commands";
import type { RuntimeConfig } from "../src/types";

describe("Discord Slash Commands", () => {
  it("builds the complete set of slash commands with correct metadata", () => {
    const commands = buildSlashCommands();
    const commandNames = commands.map((c) => c.name);

    expect(commandNames).toContain("status");
    expect(commandNames).toContain("cancel");
    expect(commandNames).toContain("help");
    expect(commandNames).toContain("settings");
    expect(commandNames).toContain("model");
    expect(commandNames).toContain("permission");
    expect(commandNames).toContain("effort");
    expect(commandNames).toContain("fork");
    expect(commandNames).toContain("branch");
    expect(commandNames).toContain("checkpoint");
    expect(commandNames).toContain("reset");
    expect(commandNames).toContain("claude");
    expect(commandNames).toContain("ask");

    const permissionCmd = commands.find((c) => c.name === "permission");
    expect(permissionCmd?.options).toBeDefined();
    const modeOpt = (permissionCmd?.options as any[])?.find((opt) => opt.name === "mode");
    expect(modeOpt?.choices?.map((ch: any) => ch.value)).toContain("acceptEdits");
    expect(modeOpt?.choices?.map((ch: any) => ch.value)).toContain("bypassPermissions");

    const askCmd = commands.find((c) => c.name === "ask");
    expect(askCmd?.options?.[0]?.name).toBe("prompt");
    expect(askCmd?.options?.[0]?.required).toBe(true);
  });

  it("rejects unauthorized users with ephemeral notice", async () => {
    let replyPayload: any = null;
    const mockInteraction: any = {
      user: { id: "unauthorized-user" },
      reply: async (payload: any) => {
        replyPayload = payload;
      },
    };

    await handleSlashCommand({
      interaction: mockInteraction,
      store: {} as any,
      config: { routes: [] } as any,
      runtime: {} as any,
      executor: {} as any,
      allowedUsers: new Set(["owner-user"]),
      cancelJobLifecycle: async () => null,
      postQueuedProgress: async () => null,
    });

    expect(replyPayload).toEqual({
      content: "이 봇은 지정된 사용자만 제어할 수 있어.",
      ephemeral: true,
    });
  });

  it("rejects unrouted channels with ephemeral notice", async () => {
    let replyPayload: any = null;
    const mockInteraction: any = {
      user: { id: "owner-user" },
      channelId: "unrouted-channel",
      channel: { isThread: () => false },
      reply: async (payload: any) => {
        replyPayload = payload;
      },
    };

    const config: RuntimeConfig = {
      ownerId: "owner-user",
      allowedUserIds: ["owner-user"],
      maxConcurrent: 3,
      maxAttempts: 2,
      jobTimeoutSeconds: 900,
      routes: [
        {
          id: "route-a",
          discordChannelId: "channel-a",
          cwd: "/path/a",
          model: "combo/auto",
          permissionMode: "acceptEdits",
          effort: "high",
          requireMention: false,
        },
      ],
    };

    await handleSlashCommand({
      interaction: mockInteraction,
      store: {} as any,
      config,
      runtime: {} as any,
      executor: {} as any,
      allowedUsers: new Set(["owner-user"]),
      cancelJobLifecycle: async () => null,
      postQueuedProgress: async () => null,
    });

    expect(replyPayload).toEqual({
      content: "이 채널에는 연결된 Claude 작업 라우트가 설정되어 있지 않아.",
      ephemeral: true,
    });
  });

  it("handles /help correctly", async () => {
    let replyPayload: any = null;
    const mockInteraction: any = {
      user: { id: "owner-user" },
      channelId: "channel-a",
      channel: { isThread: () => false },
      commandName: "help",
      reply: async (payload: any) => {
        replyPayload = payload;
      },
    };

    const config: RuntimeConfig = {
      ownerId: "owner-user",
      allowedUserIds: ["owner-user"],
      maxConcurrent: 3,
      maxAttempts: 2,
      jobTimeoutSeconds: 900,
      routes: [
        {
          id: "route-a",
          discordChannelId: "channel-a",
          cwd: "/path/a",
          model: "combo/auto",
          permissionMode: "acceptEdits",
          effort: "high",
          requireMention: false,
        },
      ],
    };

    await handleSlashCommand({
      interaction: mockInteraction,
      store: {} as any,
      config,
      runtime: {} as any,
      executor: {} as any,
      allowedUsers: new Set(["owner-user"]),
      cancelJobLifecycle: async () => null,
      postQueuedProgress: async () => null,
    });

    expect(replyPayload.ephemeral).toBe(true);
    expect(replyPayload.content).toContain("/ask");
    expect(replyPayload.content).toContain("/status");
  });
});
