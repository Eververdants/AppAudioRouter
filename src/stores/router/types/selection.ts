/** The two plans staged on the board: which processes, and where their audio
 *  is proposed to go. Neither lands anything — the hub does. */
export interface SelectionState {
  /** Processes targeted by the current selection (Ctrl+click to multi-select). */
  selectedPids: number[];
  /** Devices targeted by the current selection — the plan, in the order the
   * user built it. That order is the order the stage draws and the order the
   * route applies in: the first device is the one Windows plays natively, and
   * the delay values are the copies' compensation, never a vote on the seat. */
  selectedDeviceIds: string[];
  /**
   * Whether `selectedDeviceIds` is still the app's own guess (the process's
   * live route, or the system default it already plays through) rather than
   * something the user picked. A guess is replaced by the first device clicked,
   * so choosing a device cannot silently keep the guessed one playing
   * alongside it. The remembered route is deliberately not part of the guess —
   * until it is restored into a live route it is not where the process plays.
   */
  deviceSelectionPrefilled: boolean;
  /**
   * Programme inputs staged on the board — the feed plan, the way
   * `selectedDeviceIds` is the device plan. Picking an input in the
   * add-destination picker joins it here and lands nothing; the hub is what
   * connects it, and the hub is also what lands taking it back out.
   */
  selectedFeedPids: number[];
  /**
   * Whether `selectedFeedPids` is still the app's own copy of the program's
   * live feeds rather than something the user staged. While it stands, the
   * subscription below keeps the plan tracking the live map — a restore landing
   * at boot must not read as a proposal waiting for the hub, and pressing that
   * hub would take down a feed the user never touched. The first staging
   * freezes it, the same rule the device guess follows.
   */
  feedSelectionPrefilled: boolean;
}

/** Every edit of those two plans. All of them are plan edits and nothing else:
 *  no route moves, no wire connects, until `applyRoute` lands them. */
export interface SelectionActions {
  selectProcess: (pid: number) => void;
  toggleProcessSelection: (pid: number) => void;
  toggleDeviceSelection: (deviceId: string) => void;
  /** Append one device to the plan's tail — the add-destination picker's only
   * verb. It never *replaces* anything, which is the point: the picker used to
   * go through `toggleDeviceSelection`, whose `replacesGuess` rule quietly
   * swapped the single-device guess out, so "add a second output" could leave
   * the output you had already picked gone. The appended device joins as a
   * copy; who sits first is the plan order's to say, and the seat only moves
   * when the user asks for it. */
  appendDeviceTarget: (deviceId: string) => void;
  /** Stage one programme input on the board's feed plan — the add-destination
   *  picker's feed verb. A plan edit and nothing else: the row and its wire
   *  appear as a proposal, and the hub is what connects it, exactly as for a
   *  device. Stored under the target program's lowest pid, the same address the
   *  live map speaks, so a staged sibling never reads as a different feed. */
  appendFeedTarget: (targetPid: number) => void;
  /** Take one staged feed off the plan. For a landed feed this is the first
   *  half of its way out — the hub lands the disconnect, the way it landed the
   *  connection. */
  dropFeedTarget: (targetPid: number) => void;
  /** Make `deviceId` the seat the system plays directly. A device already in
   * the plan is moved to the front (its role swaps with the old primary and the
   * plan keeps every member); one that is not replaces the primary, leaving the
   * copies the plan already had. A device already carrying a compensation may
   * take the seat — the values are the copies' business, and recalibrating
   * after the move is the wizard's job. A plan edit and nothing else, so it
   * writes no log, exactly like `promoteDevice`: the role words on the board
   * are the feedback. */
  setPrimaryDevice: (deviceId: string) => void;
  /** Move one staged device to the front of the plan — the seat the system
   * plays directly. A reorder of the plan and nothing else: membership belongs
   * to the disc toggle, and no route moves until Apply. */
  promoteDevice: (deviceId: string) => void;
}
