import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { FunctionTool, ToolCall } from './types.js';
import { GatewayError } from './errors.js';

// Schemas are compiled per request, not retained in an unbounded global cache.
export function compileTools(tools: FunctionTool[] = []): Map<string, ValidateFunction> {
  const ajv = new Ajv({ strict: false, validateFormats: false, coerceTypes: false, removeAdditional: false, useDefaults: false, addUsedSchema: false });
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    try {
      validators.set(tool.function.name, ajv.compile(tool.function.parameters ?? { type: 'object' }));
    } catch {
      throw new GatewayError(400, 'invalid_tool_schema', `Invalid or unsupported JSON Schema for tool ${tool.function.name}. Use draft-07 with local references.`);
    }
  }
  return validators;
}

export function validateToolArguments(call: ToolCall, validators: Map<string, ValidateFunction>) {
  let args: unknown;
  try { args = JSON.parse(call.function.arguments); } catch { throw new GatewayError(502, 'invalid_tool_arguments', 'Provider returned invalid JSON function arguments.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || !validators.get(call.function.name)?.(args)) throw new GatewayError(502, 'invalid_tool_arguments', 'Provider arguments do not match the declared function schema.');
}
