import type { PositionAnalysisRequest, PositionAnalysisResult } from "./poc-tools";

/** Both Stockfish adapters retain UCI scores relative to the search root's turn. */
export function scopePositionAnalysis(result: PositionAnalysisResult, request: PositionAnalysisRequest): PositionAnalysisResult {
  const turn = request.fen.split(" ")[1];
  if (turn !== "w" && turn !== "b") throw new Error("Invalid score root turn");
  const scoreScope = {
    fen: request.fen,
    perspective: turn === "w" ? "white" : "black",
    positiveMeans: "advantage for perspective color",
    scoreCpUnit: "centipawns",
    matePlyUnit: "signed mate-in-moves (legacy field name, not plies)",
  };
  return { ...result, lines: result.lines.map(line => {
    if (line.scoreScope && Object.entries(scoreScope).some(([key, value]) => line.scoreScope?.[key] !== value)) {
      throw new Error("Engine score scope mismatch");
    }
    return { ...line, scoreScope };
  }) };
}
