// Provider catalogue verified 2026-09-06. Normal application defaults are separate.
export const SIMPLE_MODEL_CATALOGUE = [
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
  { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
  { id: "openai/gpt-5.6-terra-pro", label: "Terra 5.6 Pro" },
  { id: "openai/gpt-5.6-luna-pro", label: "Luna 5.6 Pro" },
  { id: "openai/gpt-5.6-sol", label: "Sol" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
  { id: "openai/gpt-5.6-sol-pro", label: "Sol 5.6 Pro" },
  { id: "openai/gpt-5.6-terra", label: "Terra" },
  { id: "openai/gpt-5.6-luna", label: "Luna" },
  { id: "openai/gpt-6-astra", label: "Astra 6 Standard" },
  { id: "openai/gpt-6-astra-pro", label: "Astra 6 Pro" },
  { id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "x-ai/grok-4.6", label: "Grok 4.6" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3" },
  { id: "z-ai/glm-5.3", label: "GLM 5.3" },
  { id: "qwen/qwen3.8-max-0902", label: "Qwen3.8 Max 0902" },
] as const;
export type SimpleModelId = typeof SIMPLE_MODEL_CATALOGUE[number]["id"];
export const SIMPLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type SimpleEffort = typeof SIMPLE_EFFORTS[number];
export type SimpleAgentConfig = { modelId: SimpleModelId; effort: SimpleEffort };
export type SimpleUiAllowance = "default" | "expanded";
export const EVALUATED_ASTRA_CONFIG: SimpleAgentConfig = { modelId: "openai/gpt-6-astra", effort: "medium" };
export const DEFAULT_SIMPLE_CONFIG: SimpleAgentConfig = { ...EVALUATED_ASTRA_CONFIG };
export function simpleEffortsForModel(modelId: string): readonly SimpleEffort[] {
  if (!SIMPLE_MODEL_CATALOGUE.some(m => m.id === modelId)) return [];
  if (modelId.startsWith("google/") || modelId === "anthropic/claude-haiku-4.5") return ["low", "medium", "high"];
  if (modelId === "x-ai/grok-4.6" || modelId === "qwen/qwen3.8-max-0902") return ["low", "medium", "high", "xhigh"];
  if (modelId === "moonshotai/kimi-k3" || modelId === "z-ai/glm-5.3") return ["low", "high", "max"];
  return SIMPLE_EFFORTS;
}
export function selectSimpleModel(current: SimpleAgentConfig, modelId: SimpleModelId): SimpleAgentConfig {
  const efforts = simpleEffortsForModel(modelId);
  return validateSimpleAgentConfig({ modelId, effort: efforts.includes(current.effort) ? current.effort : efforts.includes("medium") ? "medium" : "high" });
}
export function validateSimpleAgentConfig(config: SimpleAgentConfig) {
  if (!simpleEffortsForModel(config.modelId).includes(config.effort)) throw new Error("Unsupported simple-agent model/effort");
  return config;
}
export const SIMPLE_EXTENSION_CONFIGS: readonly SimpleAgentConfig[] = [
  { modelId: "openai/gpt-5.6-sol-pro", effort: "medium" },
  { modelId: "openai/gpt-5.6-terra", effort: "xhigh" },
  { modelId: "openai/gpt-5.6-luna", effort: "max" },
  { modelId: "openai/gpt-6-astra-pro", effort: "medium" },
  { modelId: "anthropic/claude-fable-5.1", effort: "medium" },
];
export const SIMPLE_VENDOR_CONFIGS: readonly SimpleAgentConfig[] = [
  { modelId: "google/gemini-3.8-flash", effort: "medium" },
  { modelId: "x-ai/grok-4.6", effort: "medium" },
  { modelId: "moonshotai/kimi-k3", effort: "high" },
  { modelId: "z-ai/glm-5.3", effort: "high" },
  { modelId: "qwen/qwen3.8-max-0902", effort: "medium" },
];
