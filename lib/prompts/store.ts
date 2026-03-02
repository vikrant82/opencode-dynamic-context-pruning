import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import type { Logger } from "../logger"
import { SYSTEM as SYSTEM_PROMPT } from "./system"
import { COMPRESS as COMPRESS_PROMPT } from "./compress"
import { CONTEXT_LIMIT_NUDGE } from "./context-limit-nudge"
import { USER_TURN_NUDGE, ASSISTANT_TURN_NUDGE } from "./turn-nudge"
import { ITERATION_NUDGE } from "./iteration-nudge"
import { MANUAL_MODE_SYSTEM_OVERLAY, SUBAGENT_SYSTEM_OVERLAY } from "./internal-overlays"

export type PromptKey =
    | "system"
    | "compress"
    | "context-limit-nudge"
    | "user-turn-nudge"
    | "assistant-turn-nudge"
    | "iteration-nudge"

type EditablePromptField =
    | "system"
    | "compress"
    | "contextLimitNudge"
    | "userTurnNudge"
    | "assistantTurnNudge"
    | "iterationNudge"

interface PromptDefinition {
    key: PromptKey
    fileName: string
    label: string
    description: string
    usage: string
    runtimeField: EditablePromptField
    instructionName?: string
}

interface PromptOverrideCandidate {
    path: string
}

interface PromptPaths {
    defaultsDir: string
    globalOverridesDir: string
    configDirOverridesDir: string | null
    projectOverridesDir: string | null
}

export interface RuntimePrompts {
    system: string
    compress: string
    contextLimitNudge: string
    userTurnNudge: string
    assistantTurnNudge: string
    iterationNudge: string
    manualOverlay: string
    subagentOverlay: string
}

const PROMPT_DEFINITIONS: PromptDefinition[] = [
    {
        key: "system",
        fileName: "system.md",
        label: "System",
        description: "Core system-level DCP instruction block",
        usage: "Injected into the model system prompt on every request",
        runtimeField: "system",
    },
    {
        key: "compress",
        fileName: "compress.md",
        label: "Compress",
        description: "compress tool instructions and summary constraints",
        usage: "Registered as the compress tool description",
        runtimeField: "compress",
    },
    {
        key: "context-limit-nudge",
        fileName: "context-limit-nudge.md",
        label: "Context Limit Nudge",
        description: "High-priority nudge when context is over max threshold",
        usage: "Injected when context usage is beyond configured max limits",
        runtimeField: "contextLimitNudge",
        instructionName: "context_buildup_warning",
    },
    {
        key: "user-turn-nudge",
        fileName: "user-turn-nudge.md",
        label: "User Turn Nudge",
        description: "Strong turn nudge attached to user messages",
        usage: "Used when nudge force is strong",
        runtimeField: "userTurnNudge",
        instructionName: "turn_nudge",
    },
    {
        key: "assistant-turn-nudge",
        fileName: "assistant-turn-nudge.md",
        label: "Assistant Turn Nudge",
        description: "Soft turn nudge attached to assistant messages",
        usage: "Used when nudge force is soft",
        runtimeField: "assistantTurnNudge",
        instructionName: "turn_nudge",
    },
    {
        key: "iteration-nudge",
        fileName: "iteration-nudge.md",
        label: "Iteration Nudge",
        description: "Nudge after many iterations without user input",
        usage: "Injected when iteration threshold is crossed",
        runtimeField: "iterationNudge",
        instructionName: "iteration_nudge",
    },
]

export const PROMPT_KEYS: PromptKey[] = [
    "system",
    "compress",
    "context-limit-nudge",
    "user-turn-nudge",
    "assistant-turn-nudge",
    "iteration-nudge",
]

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g
const LEGACY_INLINE_COMMENT_LINE_REGEX = /^[ \t]*\/\/.*?\/\/[ \t]*$/gm
const INSTRUCTION_TAG_REGEX = /^\s*<instruction\b[^>]*>[\s\S]*<\/instruction>\s*$/i
const DEFAULTS_README_FILE = "README.md"

const BUNDLED_EDITABLE_PROMPTS: Record<EditablePromptField, string> = {
    system: SYSTEM_PROMPT,
    compress: COMPRESS_PROMPT,
    contextLimitNudge: CONTEXT_LIMIT_NUDGE,
    userTurnNudge: USER_TURN_NUDGE,
    assistantTurnNudge: ASSISTANT_TURN_NUDGE,
    iterationNudge: ITERATION_NUDGE,
}

const INTERNAL_PROMPT_OVERLAYS = {
    manualOverlay: MANUAL_MODE_SYSTEM_OVERLAY,
    subagentOverlay: SUBAGENT_SYSTEM_OVERLAY,
}

function createBundledRuntimePrompts(): RuntimePrompts {
    return {
        system: BUNDLED_EDITABLE_PROMPTS.system,
        compress: BUNDLED_EDITABLE_PROMPTS.compress,
        contextLimitNudge: BUNDLED_EDITABLE_PROMPTS.contextLimitNudge,
        userTurnNudge: BUNDLED_EDITABLE_PROMPTS.userTurnNudge,
        assistantTurnNudge: BUNDLED_EDITABLE_PROMPTS.assistantTurnNudge,
        iterationNudge: BUNDLED_EDITABLE_PROMPTS.iterationNudge,
        manualOverlay: INTERNAL_PROMPT_OVERLAYS.manualOverlay,
        subagentOverlay: INTERNAL_PROMPT_OVERLAYS.subagentOverlay,
    }
}

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate)) {
            try {
                if (statSync(candidate).isDirectory()) {
                    return candidate
                }
            } catch {
                // ignore inaccessible entries while walking upward
            }
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function resolvePromptPaths(workingDirectory: string): PromptPaths {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    const globalRoot = join(configHome, "opencode", "dcp-prompts")
    const defaultsDir = join(globalRoot, "defaults")
    const globalOverridesDir = join(globalRoot, "overrides")

    const configDirOverridesDir = process.env.OPENCODE_CONFIG_DIR
        ? join(process.env.OPENCODE_CONFIG_DIR, "dcp-prompts", "overrides")
        : null

    const opencodeDir = findOpencodeDir(workingDirectory)
    const projectOverridesDir = opencodeDir ? join(opencodeDir, "dcp-prompts", "overrides") : null

    return {
        defaultsDir,
        globalOverridesDir,
        configDirOverridesDir,
        projectOverridesDir,
    }
}

function stripConditionalTag(content: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>[\\s\\S]*?<\/${tagName}>`, "gi")
    return content.replace(regex, "")
}

function hasTagPairMismatch(content: string, tagName: string): boolean {
    const openRegex = new RegExp(`<${tagName}\\b[^>]*>`, "i")
    const closeRegex = new RegExp(`<\/${tagName}>`, "i")
    return openRegex.test(content) !== closeRegex.test(content)
}

function unwrapTagIfWrapped(content: string, tagName: string): string {
    const regex = new RegExp(
        `^\\s*<${tagName}\\b[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>\\s*$`,
        "i",
    )
    const match = content.match(regex)
    if (!match) {
        return content.trim()
    }

    return match[1].trim()
}

function unwrapInstructionIfWrapped(content: string): string {
    const trimmed = content.trim()
    if (!INSTRUCTION_TAG_REGEX.test(trimmed)) {
        return trimmed
    }

    return trimmed
        .replace(/^\s*<instruction\b[^>]*>\s*/i, "")
        .replace(/\s*<\/instruction>\s*$/i, "")
        .trim()
}

function stripPromptComments(content: string): string {
    return content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .replace(HTML_COMMENT_REGEX, "")
        .replace(LEGACY_INLINE_COMMENT_LINE_REGEX, "")
}

function toEditablePromptText(definition: PromptDefinition, rawContent: string): string {
    let normalized = stripPromptComments(rawContent).trim()
    if (!normalized) {
        return ""
    }

    if (definition.key === "system") {
        normalized = stripConditionalTag(normalized, "manual")
        normalized = stripConditionalTag(normalized, "subagent")

        if (hasTagPairMismatch(normalized, "system-reminder")) {
            return ""
        }

        normalized = unwrapTagIfWrapped(normalized, "system-reminder")

        if (hasTagPairMismatch(normalized, "instruction")) {
            return ""
        }

        normalized = unwrapInstructionIfWrapped(normalized)
        return normalized.trim()
    }

    if (definition.instructionName) {
        if (hasTagPairMismatch(normalized, "instruction")) {
            return ""
        }
        normalized = unwrapInstructionIfWrapped(normalized)
    }

    return normalized.trim()
}

function wrapRuntimePromptContent(definition: PromptDefinition, editableText: string): string {
    const trimmed = editableText.trim()
    if (!trimmed) {
        return ""
    }

    if (definition.key === "system") {
        return `<system-reminder>\n<instruction name=compress_tool attention_level=high>\n${trimmed}\n</instruction>\n</system-reminder>`
    }

    if (definition.instructionName) {
        return `<instruction name=${definition.instructionName}>\n${trimmed}\n</instruction>`
    }

    return trimmed
}

function buildDefaultPromptFileContent(bundledEditableText: string): string {
    return `${bundledEditableText.trim()}\n`
}

function buildDefaultsReadmeContent(): string {
    const lines: string[] = []
    lines.push("# DCP Prompt Defaults")
    lines.push("")
    lines.push("This directory stores the DCP prompts.")
    lines.push("Each prompt file here should contain plain text only (no XML wrappers).")
    lines.push("")
    lines.push("## Creating Overrides")
    lines.push("")
    lines.push(
        "1. Copy a prompt file from this directory into an overrides directory using the same filename.",
    )
    lines.push("2. Edit the copied file using plain text.")
    lines.push("3. Restart OpenCode.")
    lines.push("")
    lines.push("To reset an override, delete the matching file from your overrides directory.")
    lines.push("")
    lines.push(
        "Do not edit the default prompt files directly, they are just for reference, only files in the overrides directory are used.",
    )
    lines.push("")
    lines.push("Override precedence (highest first):")
    lines.push("1. `.opencode/dcp-prompts/overrides/` (project)")
    lines.push("2. `$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/` (config dir)")
    lines.push("3. `~/.config/opencode/dcp-prompts/overrides/` (global)")
    lines.push("")
    lines.push("## Prompt Files")
    lines.push("")

    for (const definition of PROMPT_DEFINITIONS) {
        lines.push(`- \`${definition.fileName}\``)
        lines.push(`  - Purpose: ${definition.description}.`)
        lines.push(`  - Runtime use: ${definition.usage}.`)
    }

    return `${lines.join("\n")}\n`
}

function readFileIfExists(filePath: string): string | null {
    if (!existsSync(filePath)) {
        return null
    }

    try {
        return readFileSync(filePath, "utf-8")
    } catch {
        return null
    }
}

export class PromptStore {
    private readonly logger: Logger
    private readonly paths: PromptPaths
    private readonly customPromptsEnabled: boolean
    private runtimePrompts: RuntimePrompts

    constructor(logger: Logger, workingDirectory: string, customPromptsEnabled = false) {
        this.logger = logger
        this.paths = resolvePromptPaths(workingDirectory)
        this.customPromptsEnabled = customPromptsEnabled
        this.runtimePrompts = createBundledRuntimePrompts()

        if (this.customPromptsEnabled) {
            this.ensureDefaultFiles()
        }
        this.reload()
    }

    getRuntimePrompts(): RuntimePrompts {
        return { ...this.runtimePrompts }
    }

    reload(): void {
        const nextPrompts = createBundledRuntimePrompts()

        if (!this.customPromptsEnabled) {
            this.runtimePrompts = nextPrompts
            return
        }

        for (const definition of PROMPT_DEFINITIONS) {
            const bundledSource = BUNDLED_EDITABLE_PROMPTS[definition.runtimeField]
            const bundledEditable = toEditablePromptText(definition, bundledSource)
            const bundledRuntime = wrapRuntimePromptContent(definition, bundledEditable)
            const fallbackValue = bundledRuntime || bundledSource.trim()
            let effectiveValue = fallbackValue

            for (const candidate of this.getOverrideCandidates(definition.fileName)) {
                const rawOverride = readFileIfExists(candidate.path)
                if (rawOverride === null) {
                    continue
                }

                const editableOverride = toEditablePromptText(definition, rawOverride)
                if (!editableOverride) {
                    this.logger.warn("Prompt override is empty or invalid after normalization", {
                        key: definition.key,
                        path: candidate.path,
                    })
                    continue
                }

                const wrappedOverride = wrapRuntimePromptContent(definition, editableOverride)
                if (!wrappedOverride) {
                    this.logger.warn("Prompt override could not be wrapped for runtime", {
                        key: definition.key,
                        path: candidate.path,
                    })
                    continue
                }

                effectiveValue = wrappedOverride
                break
            }

            nextPrompts[definition.runtimeField] = effectiveValue
        }

        this.runtimePrompts = nextPrompts
    }

    private getOverrideCandidates(fileName: string): PromptOverrideCandidate[] {
        const candidates: PromptOverrideCandidate[] = []

        if (this.paths.projectOverridesDir) {
            candidates.push({
                path: join(this.paths.projectOverridesDir, fileName),
            })
        }

        if (this.paths.configDirOverridesDir) {
            candidates.push({
                path: join(this.paths.configDirOverridesDir, fileName),
            })
        }

        candidates.push({
            path: join(this.paths.globalOverridesDir, fileName),
        })

        return candidates
    }

    private ensureDefaultFiles(): void {
        try {
            mkdirSync(this.paths.defaultsDir, { recursive: true })
            mkdirSync(this.paths.globalOverridesDir, { recursive: true })
        } catch {
            this.logger.warn("Failed to initialize prompt directories", {
                defaultsDir: this.paths.defaultsDir,
                globalOverridesDir: this.paths.globalOverridesDir,
            })
            return
        }

        for (const definition of PROMPT_DEFINITIONS) {
            const bundledEditable = toEditablePromptText(
                definition,
                BUNDLED_EDITABLE_PROMPTS[definition.runtimeField],
            )
            const managedContent = buildDefaultPromptFileContent(
                bundledEditable || BUNDLED_EDITABLE_PROMPTS[definition.runtimeField],
            )
            const filePath = join(this.paths.defaultsDir, definition.fileName)

            try {
                const existing = readFileIfExists(filePath)
                if (existing === managedContent) {
                    continue
                }
                writeFileSync(filePath, managedContent, "utf-8")
            } catch {
                this.logger.warn("Failed to write default prompt file", {
                    key: definition.key,
                    path: filePath,
                })
            }
        }

        const readmePath = join(this.paths.defaultsDir, DEFAULTS_README_FILE)
        const readmeContent = buildDefaultsReadmeContent()

        try {
            const existing = readFileIfExists(readmePath)
            if (existing !== readmeContent) {
                writeFileSync(readmePath, readmeContent, "utf-8")
            }
        } catch {
            this.logger.warn("Failed to write defaults README", {
                path: readmePath,
            })
        }
    }
}
