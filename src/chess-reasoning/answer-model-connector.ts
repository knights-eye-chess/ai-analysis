import type { ModelMessage, ToolSet, JSONValue, jsonSchema, ToolModelMessage } from 'ai';
import { asSchema } from '@ai-sdk/provider-utils';

/** A single resumable model turn. No HTTP, account, storage or agent executor assumption. */
export type AnswerTurnRequest = {
  system?: string;
  messages: ModelMessage[];
  tools: Array<{name:string; description?:string; inputSchema: Parameters<typeof jsonSchema>[0]}>;
  toolChoice: 'auto' | 'none';
  maxOutputTokens: number;
  signal?: AbortSignal;
  effort: string;
};
export type AnswerToolRequest = {toolCallId:string; toolName:string; input:Record<string,unknown>};
export type AnswerTurnResult = {
  text: string;
  toolCalls: AnswerToolRequest[];
  finishReason: string;
  usage: {inputTokens?:number; outputTokens?:number};
  /** Provider continuation messages; opaque provider metadata must be preserved in memory. */
  response: {messages:ModelMessage[]; headers?:Record<string,string>};
  providerMetadata?: unknown;
};
export interface AnswerModelConnector {
  readonly kind: 'model-turn';
  readonly capabilities?: {toolRequests:boolean;toolFreeComposition:boolean;opaqueContinuation:boolean;outputTokenLimit:'enforced'|'requested'|'unavailable';usageReporting:'reported'|'optional'|'unavailable'};
  /** Connectors propose calls; only the pipeline executes them. */
  invoke(request: AnswerTurnRequest): Promise<AnswerTurnResult>;
}
export type ExecutableTurn = {
  system?:string; messages:ModelMessage[]; tools?:ToolSet; toolChoice:'auto'|'none';
  maxOutputTokens:number; maxRetries:0; abortSignal?:AbortSignal;
  providerOptions: {openai:{store:boolean;include:string[];reasoningEffort:string}};
  /** Fixed-evidence evaluation only: validate but discard unsolicited known calls. Never advertised or dispatched. */
  fixedEvidenceDiscardTools?: ToolSet;
};
/** Interface admission ceiling, separate from the inherited search-batch budget. */
export const MAX_ANSWER_TOOL_REQUESTS_PER_TURN = 32;
function validateTurnResult(result:AnswerTurnResult, tools:ToolSet, previous:ModelMessage[]) {
  if(!result || typeof result.text!=='string' || typeof result.finishReason!=='string'
    || !Array.isArray(result.toolCalls) || result.toolCalls.length>MAX_ANSWER_TOOL_REQUESTS_PER_TURN
    || !result.response || !Array.isArray(result.response.messages)
    || !result.usage || typeof result.usage!=='object')throw Error('invalid-model-turn-result');
  const ids=new Set(previous.flatMap(message=>message.role==='assistant' && Array.isArray(message.content)
    ? message.content.flatMap(part=>part.type==='tool-call'?[part.toolCallId]:[]) : []));
  // Validate the entire proposed batch before the first call has side effects.
  for(const call of result.toolCalls) {
    if(!call || typeof call.toolCallId!=='string' || !call.toolCallId.trim() || call.toolCallId.length>256 || ids.has(call.toolCallId))throw Error('invalid-model-tool-id');
    ids.add(call.toolCallId);
    if(typeof call.toolName!=='string' || !Object.hasOwn(tools,call.toolName) || !tools[call.toolName]?.execute)throw Error('unknown-model-tool');
    if(!call.input || typeof call.input!=='object' || Array.isArray(call.input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(call.input)))throw Error('invalid-model-tool-input');
  }
}
export async function invokeAnswerTurn(connector:AnswerModelConnector, request:ExecutableTurn):Promise<AnswerTurnResult> {
  request.abortSignal?.throwIfAborted();
  if(connector.kind!=='model-turn' || typeof connector.invoke!=='function')throw Error('invalid-model-connector');
  const tools = request.tools ?? {};
  const result = await connector.invoke({system:request.system,messages:request.messages,
    tools:await Promise.all(Object.entries(tools).map(async ([name,definition])=>({name,description:typeof definition.description === "string" ? definition.description : undefined,inputSchema:await asSchema(definition.inputSchema).jsonSchema}))),
    toolChoice:request.toolChoice,maxOutputTokens:request.maxOutputTokens,signal:request.abortSignal,effort:request.providerOptions.openai.reasoningEffort});
  request.abortSignal?.throwIfAborted();
  validateTurnResult(result,request.fixedEvidenceDiscardTools ?? tools,request.messages);
  if(request.toolChoice==='none' && result.toolCalls.length) {
    // The frozen-evidence study must remain one call with zero new evidence.
    // Retaining the validated proposal lets its caller report no-final-answer,
    // never treating the unsolicited tool request as a completed answer.
    if(request.fixedEvidenceDiscardTools)return result;
    throw Error('tools-disabled-during-composition');
  }
  const messages = [...result.response.messages];
  const toolResults: ToolModelMessage["content"] = [];
  for(const call of result.toolCalls) {
    request.abortSignal?.throwIfAborted();
    const definition=tools[call.toolName];
    if(!definition?.execute)throw Error('unknown-model-tool');
    const output=await definition.execute(call.input,{toolCallId:call.toolCallId,messages:request.messages,abortSignal:request.abortSignal,context:undefined});
    request.abortSignal?.throwIfAborted();
    toolResults.push({type:'tool-result',toolCallId:call.toolCallId,toolName:call.toolName,output:{type:'json',value:JSON.parse(JSON.stringify(output)) as JSONValue}});
  }
  if(toolResults.length)messages.push({role:'tool',content:toolResults});
  return {...result,response:{...result.response,messages}};
}
