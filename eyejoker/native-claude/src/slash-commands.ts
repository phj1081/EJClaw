import {
  ChatInputCommandInteraction,
  REST,
  Routes,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { formatDiscordStatus, renderStatusSnapshot } from "./status-format";
import { conversationKey } from "./bridge-utils";
import { conversationLockKey } from "./conversation-workspace";
import { resolveRoute } from "./config";
import type { ClaudeSdkExecutor } from "./sdk-executor";
import type { JobRecord, RouteConfig, RuntimeConfig } from "./types";
import type { StateStore } from "./store";
import type { JobRuntime } from "./runtime";

export function buildSlashCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("현재 실행 중인 작업 및 큐 상태를 확인합니다."),
    new SlashCommandBuilder()
      .setName("cancel")
      .setDescription("현재 대화의 진행 중이거나 대기 중인 작업을 취소합니다."),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("EJClaw Claude 브릿지 명령어 도움말을 확인합니다."),
    new SlashCommandBuilder()
      .setName("settings")
      .setDescription("현재 대화의 설정(모델, 권한, 추론 강도 등)을 확인합니다."),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("현재 대화의 모델을 변경합니다.")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("사용할 모델 이름 (기본값으로 되돌리려면 'default' 입력)")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("permission")
      .setDescription("현재 대화의 권한 모드를 변경합니다.")
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("권한 모드 선택")
          .setRequired(true)
          .addChoices(
            { name: "acceptEdits (파일 수정 자동, 도구는 승인)", value: "acceptEdits" },
            { name: "auto (자동 판단)", value: "auto" },
            { name: "manual (모든 동작 수동 승인)", value: "manual" },
            { name: "bypassPermissions (모든 권한 우회)", value: "bypassPermissions" },
            { name: "plan (계획만 수립)", value: "plan" },
            { name: "default (경로 기본값 복원)", value: "default" },
          ),
      ),
    new SlashCommandBuilder()
      .setName("effort")
      .setDescription("현재 대화의 추론 강도(effort)를 변경합니다.")
      .addStringOption((opt) =>
        opt
          .setName("level")
          .setDescription("추론 강도 레벨")
          .setRequired(true)
          .addChoices(
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" },
            { name: "xhigh", value: "xhigh" },
            { name: "max", value: "max" },
            { name: "default (기본값)", value: "default" },
          ),
      ),
    new SlashCommandBuilder()
      .setName("fork")
      .setDescription("다음 작업을 현재 세션에서 분기(fork)하여 새 세션으로 시작합니다."),
    new SlashCommandBuilder()
      .setName("branch")
      .setDescription("세션 브랜치를 관리합니다.")
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("현재 대화의 세션 브랜치 목록을 조회합니다."),
      )
      .addSubcommand((sub) =>
        sub
          .setName("use")
          .setDescription("특정 세션 브랜치로 전환합니다.")
          .addStringOption((opt) =>
            opt.setName("prefix").setDescription("세션 ID 접두사 (8자리)").setRequired(true),
          ),
      ),
    new SlashCommandBuilder()
      .setName("checkpoint")
      .setDescription("세션 체크포인트를 관리합니다.")
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("체크포인트 목록을 조회합니다."),
      ),
    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("현재 대화의 Claude 세션을 초기화합니다."),
    new SlashCommandBuilder()
      .setName("claude")
      .setDescription("Claude Code 내부 슬래시 명령어(/compact, /review 등)를 실행합니다.")
      .addStringOption((opt) =>
        opt
          .setName("command")
          .setDescription("실행할 슬래시 명령어 (예: /compact, /review, /context, /cost)")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Claude에게 작업 지시를 전달합니다.")
      .addStringOption((opt) =>
        opt.setName("prompt").setDescription("작업 내용").setRequired(true),
      ),
  ].map((builder) => builder.toJSON());
}

export async function registerSlashCommands(
  token: string,
  clientId: string,
  guildIds: string[],
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = buildSlashCommands();
  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`slash commands registered for guild=${guildId} count=${commands.length}`);
    } catch (error) {
      console.error(`failed to register slash commands for guild=${guildId}:`, error);
    }
  }
}

export interface SlashCommandHandlerContext {
  interaction: ChatInputCommandInteraction;
  store: StateStore;
  config: RuntimeConfig;
  runtime: JobRuntime;
  executor: ClaudeSdkExecutor;
  allowedUsers: Set<string>;
  cancelJobLifecycle: (jobId: string, reason: string) => Promise<JobRecord | null>;
  postQueuedProgress: (job: JobRecord) => Promise<unknown>;
}

export async function handleSlashCommand(ctx: SlashCommandHandlerContext): Promise<void> {
  const {
    interaction,
    store,
    config,
    runtime,
    executor,
    allowedUsers,
    cancelJobLifecycle,
    postQueuedProgress,
  } = ctx;

  if (!allowedUsers.has(interaction.user.id)) {
    await interaction.reply({
      content: "이 봇은 지정된 사용자만 제어할 수 있어.",
      ephemeral: true,
    });
    return;
  }

  const parentId = interaction.channel?.isThread() ? interaction.channel.parentId : null;
  const route = resolveRoute(config, interaction.channelId, parentId);
  if (!route) {
    await interaction.reply({
      content: "이 채널에는 연결된 Claude 작업 라우트가 설정되어 있지 않아.",
      ephemeral: true,
    });
    return;
  }

  const key = conversationKey(route, interaction.channelId);
  const commandName = interaction.commandName;

  switch (commandName) {
    case "status": {
      const active = store.listActive();
      await interaction.reply({
        content: formatDiscordStatus(renderStatusSnapshot(active)),
        ephemeral: true,
      });
      break;
    }

    case "cancel": {
      const candidates = store.listActive().filter((job) => job.conversationKey === key);
      const cancelled: JobRecord[] = [];
      for (const candidate of candidates) {
        const result = await cancelJobLifecycle(candidate.id, "cancelled by user via slash command");
        if (result) cancelled.push(result);
      }
      await interaction.reply({
        content: `중지 요청 ${cancelled.length}건 처리`,
      });
      break;
    }

    case "settings": {
      const settings = store.getConversationSettings(key);
      await interaction.reply({
        content: [
          `model: ${settings.model ?? `${route.model} (route default)`}`,
          `fallback: ${route.fallbackModel ?? "없음"}`,
          `permission: ${settings.permissionMode ?? `${route.permissionMode} (route default)`}`,
          `effort: ${settings.effort ?? `${route.effort} (route default)`}`,
          `fork next: ${settings.forkNext ? "yes" : "no"}`,
          `session history: ${store.sessionHasHistory(key) ? "yes" : "no"}`,
        ].join("\n"),
        ephemeral: true,
      });
      break;
    }

    case "help": {
      await interaction.reply({
        content:
          "**EJClaw 슬래시 명령어 도움말**\n" +
          "• `/ask <내용>`: Claude에게 작업 요청\n" +
          "• `/status`: 현재 실행 중인 작업 및 큐 상태\n" +
          "• `/cancel`: 현재 대화의 작업 취소\n" +
          "• `/settings`: 현재 모델/권한/추론 강도 설정 확인\n" +
          "• `/model <name>`: 모델 변경 (기본값 복원은 'default')\n" +
          "• `/permission <mode>`: 권한 모드 변경 (acceptEdits, auto, manual 등)\n" +
          "• `/effort <level>`: 추론 강도 변경 (low, medium, high, max 등)\n" +
          "• `/fork`: 현재 세션에서 분기하여 새 세션 시작\n" +
          "• `/branch list|use`: 세션 브랜치 목록 확인 및 전환\n" +
          "• `/checkpoint list`: 세션 체크포인트 목록\n" +
          "• `/reset`: 세션 초기화\n" +
          "• `/claude <명령어>`: Claude 내부 슬래시 명령어 실행 (/compact, /review 등)",
        ephemeral: true,
      });
      break;
    }

    case "model": {
      const modelArg = interaction.options.getString("name", true).trim();
      const value = modelArg === "default" ? null : modelArg;
      const running = store
        .listActive()
        .find((job) => job.conversationKey === key && job.status === "running");
      let appliedLive = false;
      if (running) {
        try {
          appliedLive = await executor.setModel(running.id, value ?? route.model);
        } catch (error: unknown) {
          await interaction.reply({
            content: `실행 중 모델 변경 실패: ${error instanceof Error ? error.message : String(error)}`,
            ephemeral: true,
          });
          return;
        }
      }
      const settings = store.setConversationSetting(key, "model", value);
      await interaction.reply({
        content: `${appliedLive ? "실행 중 적용 + " : ""}모델 설정됨: ${settings.model ?? route.model}`,
      });
      break;
    }

    case "permission": {
      const modeArg = interaction.options.getString("mode", true).trim();
      const value = modeArg === "default" ? null : modeArg;
      const running = store
        .listActive()
        .find((job) => job.conversationKey === key && job.status === "running");
      let appliedLive = false;
      if (running) {
        try {
          appliedLive = await executor.setPermissionMode(
            running.id,
            (value ?? route.permissionMode) as RouteConfig["permissionMode"],
          );
        } catch (error: unknown) {
          await interaction.reply({
            content: `실행 중 권한 모드 변경 실패: ${error instanceof Error ? error.message : String(error)}`,
            ephemeral: true,
          });
          return;
        }
      }
      const settings = store.setConversationSetting(key, "permissionMode", value);
      await interaction.reply({
        content: `${appliedLive ? "실행 중 적용 + " : ""}권한 모드 설정됨: ${settings.permissionMode ?? route.permissionMode}`,
      });
      break;
    }

    case "effort": {
      const levelArg = interaction.options.getString("level", true).trim();
      const value = levelArg === "default" ? null : levelArg;
      const settings = store.setConversationSetting(key, "effort", value);
      await interaction.reply({
        content: `추론 강도(effort) 설정됨: ${settings.effort ?? route.effort}`,
      });
      break;
    }

    case "fork": {
      store.requestFork(key);
      await interaction.reply({
        content: "다음 작업을 현재 세션에서 fork하도록 예약했어.",
      });
      break;
    }

    case "branch": {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "list") {
        const branches = store.listSessionBranches(key);
        const content = branches.length
          ? branches
              .map(
                (branch) =>
                  `${branch.status === "active" ? "*" : "-"} ${branch.sessionId.slice(0, 8)} · ${branch.label ?? "session"}`,
              )
              .join("\n")
          : "기록된 세션 브랜치가 없어.";
        await interaction.reply({ content, ephemeral: true });
      } else if (subcommand === "use") {
        const prefix = interaction.options.getString("prefix", true).trim();
        const matched = store.useSessionBranch(key, prefix);
        await interaction.reply({
          content: matched
            ? `세션 브랜치를 ${matched.sessionId.slice(0, 8)}로 전환했어.`
            : `일치하는 세션 브랜치를 찾지 못했어: ${prefix}`,
        });
      }
      break;
    }

    case "checkpoint": {
      const checkpoints = store.listSessionCheckpoints(key);
      const content = checkpoints.length
        ? checkpoints
            .map(
              (cp) =>
                `- ${cp.userMessageId} · session=${cp.sessionId.slice(0, 8)} · ${cp.createdAt}`,
            )
            .join("\n")
        : "기록된 체크포인트가 없어.";
      await interaction.reply({ content, ephemeral: true });
      break;
    }

    case "reset": {
      const active = store.listActive().some((candidate) => candidate.conversationKey === key);
      if (active) {
        await interaction.reply({
          content: "실행·대기 중인 작업이 있어서 reset하지 않았어. 먼저 /cancel 해줘.",
          ephemeral: true,
        });
      } else {
        store.resetSession(key, route.id);
        await interaction.reply({
          content: "Claude 세션을 새로 시작하도록 reset했어.",
        });
      }
      break;
    }

    case "claude": {
      const cmd = interaction.options.getString("command", true).trim();
      const formattedCmd = cmd.startsWith("/") ? cmd : `/${cmd}`;
      await interaction.deferReply();
      const replyMsg = await interaction.fetchReply();
      const job = store.enqueue({
        routeId: route.id,
        lockKey: conversationLockKey(route, key),
        conversationKey: key,
        channelId: interaction.channelId,
        threadId: parentId ? interaction.channelId : null,
        messageId: replyMsg.id,
        authorId: interaction.user.id,
        prompt: formattedCmd,
        rawPrompt: true,
        attachmentPaths: [],
        holdForProgress: true,
      });
      try {
        await postQueuedProgress(job);
      } catch (error: unknown) {
        console.warn(`queued progress held id=${job.id}`, error);
      }
      console.log(
        `slash raw job queued id=${job.id} route=${route.id} channel=${interaction.channelId} author=${interaction.user.id}`,
      );
      void runtime.runUntilIdle().catch((error: unknown) => console.error("job pump failed", error));
      break;
    }

    case "ask": {
      const prompt = interaction.options.getString("prompt", true).trim();
      await interaction.deferReply();
      const replyMsg = await interaction.fetchReply();
      const job = store.enqueue({
        routeId: route.id,
        lockKey: conversationLockKey(route, key),
        conversationKey: key,
        channelId: interaction.channelId,
        threadId: parentId ? interaction.channelId : null,
        messageId: replyMsg.id,
        authorId: interaction.user.id,
        prompt,
        rawPrompt: false,
        attachmentPaths: [],
        holdForProgress: true,
      });
      try {
        await postQueuedProgress(job);
      } catch (error: unknown) {
        console.warn(`queued progress held id=${job.id}`, error);
      }
      console.log(
        `slash ask job queued id=${job.id} route=${route.id} channel=${interaction.channelId} author=${interaction.user.id} len=${prompt.length}`,
      );
      void runtime.runUntilIdle().catch((error: unknown) => console.error("job pump failed", error));
      break;
    }

    default: {
      await interaction.reply({
        content: `알 수 없는 슬래시 명령어: ${commandName}`,
        ephemeral: true,
      });
    }
  }
}
