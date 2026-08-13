import "./prune-env"
import type { PluginConfig } from "../lib/config"
import type { SessionState, ToolParameterEntry, WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"

export function buildPruneConfig(overrides?: { protectedTools?: string[] }): PluginConfig {
    return {
        enabled: true,
        debug: false,
        autoUpdate: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: overrides?.protectedTools ?? [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: false,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            summaryBudget: 0,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            minSavingsThreshold: 0,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
            staleTools: { enabled: false, turns: 3, protectedTools: [] },
        },
    }
}

export function buildState(currentTurn: number): SessionState {
    const state = createSessionState()
    state.sessionId = `ses_prune_test_${Math.random().toString(36).slice(2)}`
    state.currentTurn = currentTurn
    return state
}

export function addTool(
    state: SessionState,
    callID: string,
    tool: string,
    opts: {
        turn: number
        status?: ToolParameterEntry["status"]
        tokenCount?: number
        parameters?: unknown
    },
): void {
    state.toolParameters.set(callID, {
        tool,
        parameters: opts.parameters ?? {},
        status: opts.status ?? "completed",
        turn: opts.turn,
        tokenCount: opts.tokenCount ?? 100,
    })
}

export function toolMessage(
    callID: string,
    tool: string,
    output: string,
    status = "completed",
): WithParts {
    return {
        info: {
            id: `msg_${callID}`,
            role: "assistant",
            time: { created: Date.now() },
        } as any,
        parts: [
            {
                type: "tool",
                callID,
                tool,
                state: { status, input: {}, output },
            } as any,
        ],
    } as WithParts
}

export function fakeClient(sent: string[]): any {
    return {
        session: {
            prompt: async (req: any) => {
                for (const part of req?.body?.parts ?? []) {
                    if (part?.type === "text") {
                        sent.push(part.text)
                    }
                }
                return {}
            },
        },
    }
}

export function testLogger(): Logger {
    return new Logger(false)
}
