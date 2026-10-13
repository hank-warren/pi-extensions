import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Remote answers: opt-in (`"remoteAnswers": true`), off by default.
 *
 * While an approval prompt is open, it is announced on pi's event bus, and another
 * extension in the same pi process may answer it — for example one that relays the
 * prompt to the user's phone. The terminal prompt is unchanged and stays live: whichever
 * answer comes first settles it, through the same path as a keypress.
 *
 * Off, nothing is emitted and every answer is ignored, because no prompt is ever
 * registered. An answer is honoured only for a prompt that is open right now, by its
 * id, and only with one of the options that prompt offers; everything else is dropped.
 */

/** Emitted when a prompt opens (`active: true`) and when it settles (`active: false`). */
export const PROMPT_EVENT = "auto-permissions:prompt";
/** Listened on: `{ id, choice }` answers the open prompt `id` with `choice`. */
export const ANSWER_EVENT = "auto-permissions:answer";

export interface RemotePromptOpened {
  active: true;
  /** Unique per prompt; an answer must name it. */
  id: string;
  gate: string;
  header: string;
  command: string;
  noteLabel: string;
  note: string;
  /** The options exactly as the prompt offers them, in order. */
  options: string[];
  cwd: string;
  sessionId?: string;
  openedAt: number;
}

export interface RemotePromptClosed {
  active: false;
  id: string;
  /** The option picked, or undefined when the prompt was cancelled (Esc, abort, shutdown). */
  choice?: string;
  /** True when the choice came through ANSWER_EVENT rather than the terminal. */
  remote: boolean;
}

export interface RemoteAnswer {
  id: string;
  choice: string;
}

interface OpenPrompt {
  options: readonly string[];
  answer?: (choice: string) => boolean;
  remote: boolean;
}

/** A registered prompt: `attach` receives the prompt's answer function, `close` announces the outcome. */
export interface RemotePromptHandle {
  id: string;
  /** `answer` settles the prompt with a choice and returns false when it had already settled. */
  attach(answer: (choice: string) => boolean): void;
  close(choice: string | undefined): void;
}

export class RemotePrompts {
  private readonly open = new Map<string, OpenPrompt>();

  constructor(private readonly pi: ExtensionAPI) {}

  /** Subscribe to ANSWER_EVENT. Inert while no prompt is registered. */
  listen(): () => void {
    return this.pi.events.on(ANSWER_EVENT, (data) => {
      this.answer(data);
    });
  }

  /** Register an open prompt and announce it. */
  begin(prompt: Omit<RemotePromptOpened, "active" | "id" | "openedAt">): RemotePromptHandle {
    const id = randomUUID();
    const entry: OpenPrompt = { options: [...prompt.options], remote: false };
    this.open.set(id, entry);
    this.emit({ active: true, id, ...prompt, options: [...prompt.options], openedAt: Date.now() } satisfies RemotePromptOpened);
    return {
      id,
      attach: (answer) => {
        entry.answer = answer;
      },
      close: (choice) => {
        if (!this.open.delete(id)) return;
        this.emit({ active: false, id, ...(choice === undefined ? {} : { choice }), remote: entry.remote } satisfies RemotePromptClosed);
      },
    };
  }

  /** Apply an answer; true when it settled an open prompt. */
  answer(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const { id, choice } = data as Partial<RemoteAnswer>;
    if (typeof id !== "string" || typeof choice !== "string") return false;
    const entry = this.open.get(id);
    if (!entry?.answer || !entry.options.includes(choice)) return false;
    if (!entry.answer(choice)) return false;
    entry.remote = true;
    return true;
  }

  private emit(payload: RemotePromptOpened | RemotePromptClosed): void {
    try {
      this.pi.events.emit(PROMPT_EVENT, payload);
    } catch {
      // A listener's failure must never break the approval flow.
    }
  }
}
