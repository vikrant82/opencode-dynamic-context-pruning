import { createSessionState, resetSessionState } from "./state"
import type { SessionState } from "./types"

/**
 * Keeps isolated mutable state per OpenCode session with bounded LRU retention.
 * Initialization promises are shared per session, and in-flight sessions are
 * protected from eviction; initializer errors propagate and may be retried.
 */
export class SessionStateStore {
    private readonly states = new Map<string, SessionState>()
    private readonly initializing = new Map<string, Promise<void>>()
    private readonly initialized = new Set<string>()

    constructor(private readonly capacity = 64) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error("SessionStateStore capacity must be a positive integer")
        }
    }

    /** Return state for id, creating it if needed; updates LRU order without initialization. */
    get(id: string): SessionState {
        let state = this.states.get(id)
        if (!state) {
            state = createSessionState()
            this.states.set(id, state)
        }
        this.touch(id, state)
        this.evict()
        return state
    }

    /** Return existing state without creating it or changing its LRU position. */
    peek(id: string): SessionState | undefined {
        return this.states.get(id)
    }

    /** Return state only after initialization has completed successfully. */
    peekInitialized(id: string): SessionState | undefined {
        return this.initialized.has(id) ? this.states.get(id) : undefined
    }

    /** Share in-flight initialization per id; failures propagate and clear for a later retry. */
    async ensureInitialized(
        id: string,
        init: (state: SessionState) => Promise<void>,
    ): Promise<SessionState> {
        let state = this.states.get(id)
        if (!state) {
            state = createSessionState()
            this.states.set(id, state)
        }
        this.touch(id, state)
        if (this.initialized.has(id)) {
            this.evict()
            return state
        }
        let pending = this.initializing.get(id)
        if (!pending) {
            pending = Promise.resolve()
                .then(() => init(state!))
                .then(() => {
                    this.initialized.add(id)
                })
                .catch((error) => {
                    resetSessionState(state!)
                    throw error
                })
                .finally(() => this.initializing.delete(id))
            this.initializing.set(id, pending)
        }
        this.evict()
        try {
            await pending
            return state
        } finally {
            this.evict()
        }
    }

    private touch(id: string, state: SessionState): void {
        this.states.delete(id)
        this.states.set(id, state)
    }

    private evict(): void {
        while (this.states.size > this.capacity) {
            const candidate = [...this.states.keys()].find((id) => !this.initializing.has(id))
            if (!candidate) return
            this.states.delete(candidate)
            this.initialized.delete(candidate)
        }
    }
}
