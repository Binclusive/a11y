import type { Summary } from "../schema.js";

/**
 * health.ts — the summary health band (SPEC §5).
 *
 *   rotten  if highSeverityCount > 5 OR smellCount / max(fileCount,1) >= 1.0
 *   healthy if highSeverityCount === 0 AND smellCount / max(fileCount,1) < 0.3
 *   rough   otherwise
 */
export function healthBand(input: {
  smellCount: number;
  highSeverityCount: number;
  fileCount: number;
}): Summary["health"] {
  const { smellCount, highSeverityCount, fileCount } = input;
  const density = smellCount / Math.max(fileCount, 1);
  if (highSeverityCount > 5 || density >= 1.0) return "rotten";
  if (highSeverityCount === 0 && density < 0.3) return "healthy";
  return "rough";
}
