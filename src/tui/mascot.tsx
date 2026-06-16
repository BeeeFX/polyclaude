import { Box, Text } from "ink";

/**
 * Poly — polyclaude's purple block mascot. Static (idle animations were tried
 * and removed at the user's request). Drawn as a pixel grid, one block char per
 * pixel; eyes are holes so on a dark terminal she's purple with dark eyes.
 *   #  = purple block      O = eye (hole)      .  = empty
 */

export const POLY_PURPLE = "#A78BFA";
export const mascotName = "Poly";

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

function rowToBlocks(row: string): string {
  return [...row].map((ch) => (ch === "#" ? "█" : " ")).join("");
}

export function Mascot({ color = POLY_PURPLE }: { color?: string } = {}) {
  return (
    <Box flexDirection="column">
      {POLY_ART.map((row, i) => (
        <Text key={i} color={color}>
          {rowToBlocks(row)}
        </Text>
      ))}
    </Box>
  );
}
