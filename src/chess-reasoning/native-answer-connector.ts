import { generateText, jsonSchema, tool, type LanguageModel } from 'ai';
import type { AnswerModelConnector } from './answer-model-connector';
/** Native SDK performs exactly one model turn; pipeline owns tool dispatch. */
export function createNativeAnswerConnector(model:LanguageModel):AnswerModelConnector {
  return {kind:'model-turn',capabilities:{toolRequests:true,toolFreeComposition:true,opaqueContinuation:true,outputTokenLimit:'requested',usageReporting:'optional'},async invoke(request) {
    const result=await generateText({model,system:request.system,messages:request.messages,
      tools:request.tools.length ? Object.fromEntries(request.tools.map(d=>[d.name,tool({description:d.description,inputSchema:jsonSchema<Record<string,unknown>>(d.inputSchema as Parameters<typeof jsonSchema>[0])})])) : undefined,
      toolChoice:request.toolChoice,maxOutputTokens:request.maxOutputTokens,maxRetries:0,abortSignal:request.signal,
      providerOptions:{openai:{store:false,include:['reasoning.encrypted_content'],reasoningEffort:request.effort}}});
    return {text:result.text,toolCalls:result.toolCalls.map(c=>({toolCallId:c.toolCallId,toolName:c.toolName,input:c.input as Record<string,unknown>})),
      finishReason:result.finishReason,usage:result.usage,response:result.response,providerMetadata:result.providerMetadata};
  }};
}
