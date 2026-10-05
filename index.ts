import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { createCompressMessageTool, createCompressRangeTool } from "./lib/compress"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    resolvePruneHostPermission,
    type HostPermissionSnapshot,
} from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { SessionStateStore } from "./lib/state"
import { PromptStore } from "./lib/prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { startAutoUpdate } from "./lib/update"
import { createAgentPruneTool } from "./lib/agent-prune"

declare const __DCP_VERSION__: string

const id = "opencode-dynamic-context-pruning"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const store = new SessionStateStore()
    const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
        // logger.info("Secure mode detected, configured client authentication")
    }

    logger.info("DCP initialized", {
        version: __DCP_VERSION__,
        strategies: config.strategies,
    })

    startAutoUpdate(ctx, config.autoUpdate)

    const compressToolContext = {
        client: ctx.client,
        stateStore: store,
        logger,
        config,
        prompts,
    }

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(
            store,
            logger,
            config,
            prompts,
        ),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            store,
            logger,
            config,
            prompts,
            hostPermissions,
            ctx.directory,
        ) as any,
        "experimental.text.complete": createTextCompleteHandler(),
        "command.execute.before": createCommandExecuteHandler(
            ctx.client,
            store,
            logger,
            config,
            ctx.directory,
            hostPermissions,
        ),
        event: createEventHandler(store, logger),
        tool: {
            ...(config.prune.enabled &&
                config.prune.permission !== "deny" && {
                    dcp_prune: createAgentPruneTool({ ...compressToolContext, hostPermissions }),
                }),
            ...(config.compress.permission !== "deny" && {
                compress:
                    config.compress.mode === "message"
                        ? createCompressMessageTool(compressToolContext)
                        : createCompressRangeTool(compressToolContext),
            }),
        },
        config: async (opencodeConfig) => {
            if (
                resolvePruneHostPermission({ global: opencodeConfig.permission, agents: {} }) ===
                "deny"
            )
                config.prune.permission = "deny"
            if (
                config.compress.permission !== "deny" &&
                compressDisabledByOpencode(opencodeConfig.permission)
            ) {
                config.compress.permission = "deny"
            }

            if (config.commands.enabled && config.compress.permission !== "deny") {
                opencodeConfig.command ??= {}
                opencodeConfig.command["dcp"] = {
                    template: "",
                    description: "Show available DCP commands",
                }
                opencodeConfig.command["dcp-compress"] = {
                    template: "",
                    description: "Trigger DCP manual compression with: /dcp-compress [focus]",
                }
            }

            const toolsToAdd: string[] = []
            if (config.prune.enabled) toolsToAdd.push("dcp_prune")
            if (config.compress.permission !== "deny" && !config.experimental.allowSubAgents) {
                toolsToAdd.push("compress")
            }

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "compress")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...(typeof permission === "string" ? { "*": permission } : permission),
                    compress: config.compress.permission,
                } as unknown as typeof permission
            }

            if (config.prune.enabled) {
                const permission = opencodeConfig.permission ?? {}
                const existing =
                    typeof permission === "object"
                        ? (permission as Record<string, any>).dcp_prune
                        : undefined
                opencodeConfig.permission = {
                    ...(typeof permission === "string" ? { "*": permission } : permission),
                    dcp_prune:
                        existing && typeof existing === "object"
                            ? Object.prototype.hasOwnProperty.call(existing, "*")
                                ? existing
                                : { "*": config.prune.permission, ...existing }
                            : (existing ?? config.prune.permission),
                } as unknown as typeof permission
            }
            hostPermissions.global = structuredClone(opencodeConfig.permission)
            hostPermissions.agents = Object.fromEntries(
                Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]) => [
                    name,
                    structuredClone(agent?.permission),
                ]),
            )
        },
    }
}) satisfies Plugin

export default server
