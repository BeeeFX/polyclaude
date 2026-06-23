// Poly — polyclaude's purple block mascot, rendered as crisp SVG pixels.
// Same grid as the TUI mascot (src/tui/mascot.tsx): "#" = purple block, eyes are
// holes (left empty) so on a dark surface she has dark eyes.
const POLY_ART = [
  ".##...........##.",
  "...##.......##...",
  "..#############..",
  "..####OO###OO##..",
  "..#############..",
  "#################",
  "#################",
  "..#############..",
  "....##.....##....",
  "...###.....###...",
];

const COLS = 17;
const ROWS = POLY_ART.length;

export function Mascot({ size = 22 }: { size?: number }) {
  const cells: Array<{ x: number; y: number }> = [];
  POLY_ART.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === "#") cells.push({ x, y });
    });
  });
  return (
    <svg
      width={(size * COLS) / ROWS}
      height={size}
      viewBox={`0 0 ${COLS} ${ROWS}`}
      shapeRendering="crispEdges"
      aria-label="Poly, the polyclaude mascot"
      style={{ display: "block" }}
    >
      {cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1.04} height={1.04} rx={0.18} fill="var(--accent)" />
      ))}
    </svg>
  );
}
