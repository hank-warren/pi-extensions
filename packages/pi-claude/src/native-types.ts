import type { RateLimitInfo } from "./billing.ts";

export type JsonRecord = Record<string, unknown>;

export interface NativeUsage extends JsonRecord {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
    [key: string]: unknown;
  };
  output_tokens_details?: {
    thinking_tokens?: number;
    [key: string]: unknown;
  };
}

export type NativeContentBlock =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "thinking"; thinking: string; signature?: string; [key: string]: unknown }
  | { type: "redacted_thinking"; data: string; [key: string]: unknown }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; [key: string]: unknown };

export interface NativeMessage extends JsonRecord {
  id?: string;
  model?: string;
  role: "assistant";
  content: NativeContentBlock[];
  usage?: NativeUsage;
  stop_reason?: string | null;
}

export type AnthropicStreamEvent =
  | { type: "message_start"; message: NativeMessage }
  | { type: "content_block_start"; index: number; content_block: NativeContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: string; [key: string]: unknown };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string | null; [key: string]: unknown };
      usage?: Partial<NativeUsage>;
    }
  | { type: "message_stop" }
  | { type: "error"; error?: { type?: string; message?: string } };

export interface NativeResult extends JsonRecord {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: unknown[];
  session_id?: string;
  usage?: NativeUsage;
  modelUsage?: Record<string, { contextWindow?: number; maxOutputTokens?: number; [key: string]: unknown }>;
}

/** The subset of Claude Code's stream-json output this extension reads. */
export type NativeOutputEvent =
  | { type: "system"; subtype?: string; session_id?: string; uuid?: string; [key: string]: unknown }
  | { type: "assistant"; message: NativeMessage; uuid?: string; session_id?: string; error?: unknown; parent_tool_use_id?: string | null }
  | { type: "user"; message: { role: "user"; content: unknown }; uuid?: string; session_id?: string; parent_tool_use_id?: string | null }
  | NativeResult
  | { type: "stream_event"; event: AnthropicStreamEvent; session_id?: string; parent_tool_use_id?: string | null }
  | { type: "rate_limit_event"; rate_limit_info?: RateLimitInfo }
  | { type: "control_response"; response: { subtype?: string; request_id?: string; response?: JsonRecord; error?: string } }
  | { type: "control_request"; request_id?: string; request?: JsonRecord }
  | { type: string; [key: string]: unknown };
