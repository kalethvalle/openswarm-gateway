export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Message {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  // Opaque provider state is kept only within its originating agent/model.
  reasoning?: string;
  reasoning_details?: unknown[];
}
export interface FunctionTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}
export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
export interface ChatRequest {
  model: 'openswarm-auto'; messages: Message[]; stream: boolean; n?: 1;
  tools?: FunctionTool[]; tool_choice?: ToolChoice; parallel_tool_calls?: boolean;
  temperature?: number; top_p?: number; stop?: string | string[] | null;
  max_tokens?: number; max_completion_tokens?: number;
  stream_options?: { include_usage?: boolean };
}
export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';
export interface Completion {
  id: string; object: 'chat.completion'; created: number; model: 'openswarm-auto';
  choices: [{ index: 0; message: Message; finish_reason: FinishReason }];
  usage?: Usage;
}
export interface AgentStep { role: string; objective: string; instructions: string; model: string; output: 'handoff' | 'final' }
export interface Plan { intent: string; steps: AgentStep[] }
export interface StageResult { role: string; objective: string; content: string; toolTranscript?: Message[] }
export interface RunState {
  budget?: RunBudget;
  id: string; plan?: Plan; step: number; results: StageResult[];
  conversation: Message[]; expectedMessages: Message[]; tools?: FunctionTool[];
  agentMessages?: Message[]; activeModel?: string; toolRounds: number;
  pending?: { publicId: string; providerId: string }[];
}
export interface RunBudget { calls: number; tokens: number }
export interface ModelInfo { id: string; contextLength: number; supportedParameters: string[] }
export interface ProviderInput {
  response_format?: { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } };
  model: string; messages: Message[]; tools?: FunctionTool[]; tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean; temperature?: number; top_p?: number;
  stop?: string | string[] | null; max_tokens: number; stream: boolean;
}
export interface ProviderResult { model: string; message: Message; finishReason: FinishReason; usage?: Usage }
export interface ProviderAdapter {
  catalog(signal: AbortSignal): Promise<ModelInfo[]>;
  complete(input: ProviderInput, signal: AbortSignal, onText?: (text: string) => Promise<void>): Promise<ProviderResult>;
}
export type Log = (fields: Record<string, unknown>, message: string) => void;
