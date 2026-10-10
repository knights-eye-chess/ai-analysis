# Experimental research and evidence replay

`@knights-eye-chess/ai-analysis/research` is an explicitly named, unstable surface
for the existing staged semantic, ablation, evidence projection and historical
replay tools. It is not a second implementation or a set of private source-path
exports. It includes the ordinary root API so mixed research packets use the same
context, reference and tool identities. The build uses shared ESM chunks to
preserve identities across both entry points.

The named exports in `src/chess-reasoning/research-exports.ts` were inventoried
from active application research modules, replay scripts and corpus tests on
10 October 2026. Their size reflects several generations of still active
research: fact/observation providers, concept/identity and hypothesis contracts,
semantic graph creation, ablation synthesis and evidence capture, transport
correction, material/mechanism and compact evidence transforms, branch and
recorded-position searches, answer-reference validation and trace replay. The
application's existing experimental barrel continues to compose its host-owned
runners and fixtures with these owner exports. No wildcard private module-path
export pattern is provided. Component-private modules without a consumer stay
private. This entry point gives no promise of live provider quality, production
policy selection or stable research interfaces.

Nine self-contained source tests moved from the app to `test/owner`; the additional
prose admission test covers the adopted v22 capability. Fixture/corpus, browser,
server and application policy tests remain application integration checks and
consume installed exports. Historical study evidence remains at its recorded
paths; current source-hash collectors read the installed package's included
source for provenance only, never as a runtime import.
