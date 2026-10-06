export type PlayerPerspective = Readonly<{
  side: "white" | "black";
  basis: "linked-lichess-identity" | "chesscom-lookup-handle";
}>;

export type PlayerPerspectiveIdentity = Readonly<{
  provider: string;
  providerUserId: string;
  displayName: string;
}>;

function normalizedPlayerName(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase();
}

function uniquelyMatchedSide(white: string, black: string, names: readonly string[]): PlayerPerspective["side"] | null {
  const candidates = new Set(names.map(normalizedPlayerName).filter(Boolean));
  if (!candidates.size) return null;
  const whiteMatch = candidates.has(normalizedPlayerName(white));
  const blackMatch = candidates.has(normalizedPlayerName(black));
  return whiteMatch === blackMatch ? null : whiteMatch ? "white" : "black";
}

/** Resolve the current viewer's side without using board orientation or stored game data. */
export function resolvePlayerPerspective(input: {
  white: string;
  black: string;
  providerIdentities?: readonly PlayerPerspectiveIdentity[];
  chessComLookupHandle?: string;
}): PlayerPerspective | null {
  const lichessNames = (input.providerIdentities || [])
    .filter((identity) => identity.provider === "lichess")
    .flatMap((identity) => [identity.providerUserId, identity.displayName]);
  const lichessSide = uniquelyMatchedSide(input.white, input.black, lichessNames);
  const chessComSide = uniquelyMatchedSide(input.white, input.black, [input.chessComLookupHandle || ""]);
  if (lichessSide && chessComSide && lichessSide !== chessComSide) return null;
  if (lichessSide) return { side: lichessSide, basis: "linked-lichess-identity" };
  if (chessComSide) return { side: chessComSide, basis: "chesscom-lookup-handle" };
  return null;
}

