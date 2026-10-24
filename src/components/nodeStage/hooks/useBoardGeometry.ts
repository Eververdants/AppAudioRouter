import { BOARD_H, GROUP_HEADER_H, HUB_H, boardCentre, panelColumn } from '@/lib/stage';

/**
 * The board's own arithmetic: where the panels sit and how tall the board is.
 *
 * Everything comes from `lib/stage.ts` and the single height the well reports,
 * so a row and the wire meeting it cannot disagree; nothing here measures a card.
 */
export function useBoardGeometry({
  measured,
  copiesRows,
}: {
  /** The well's height, or 0 until the one ResizeObserver has answered. */
  measured: number;
  /** Every row the copies panel holds: the column sizes itself to them. */
  copiesRows: number;
}) {
  // The board is as tall as the well it sits in, and no taller: that is the
  // whole reason the stage never scrolls. Until the well has reported a height
  // (the very first frame), the app's own default window stands in.
  const height = measured > 0 ? Math.floor(measured) : BOARD_H;
  // The two panels, as one column centred on the hub: whatever the route's
  // length, the hub sits in the middle of it with wires reaching both ways.
  const column = panelColumn(height, copiesRows);
  const hubY = Math.round(boardCentre(height) - HUB_H / 2);

  // The pickers scroll instead of growing past the board: each caps itself to
  // the room under its anchor (bounded by a sane maximum), and the menu's own
  // border and padding (2 + 12 px) come off what the inner list may take.
  const addPickerTop = Math.min(column.copiesY + GROUP_HEADER_H + 8, height - 190);
  const addPickerCap = Math.max(96, Math.min(288, height - addPickerTop - 6));
  const primaryPickerTop = Math.min(column.primaryY + column.primaryHeight + 6, height - 190);
  const primaryPickerCap = Math.max(96, Math.min(288, height - primaryPickerTop - 6));

  return {
    height,
    column,
    hubY,
    addPickerTop,
    addPickerCap,
    primaryPickerTop,
    primaryPickerCap,
  };
}
