# Open-world terrain sweep brief

Build a small, playable 3D open-world exploration game from the supplied `reference.png`.

- Make the player walk across a continuous world at least 500 by 500 world units with visible terrain relief.
- Stream or reveal terrain and content while the player travels across at least three chunk boundaries.
- Keep the player and the next destination readable with a third-person or elevated camera.
- Include at least two landmarks or points of interest that are separated by the traversal.
- Keep the first playable screen visible without a user account or external asset service.
- The sealed proof uses `ArrowRight` for the measured traversal.
- The sealed proof reads resource `state` paths `state.distance`, `state.currentChunk`, and
  `state.activeChunks`.

Proof must hold the right arrow for a measured traversal of at least 300 units, assert that
an old chunk is absent and a forward chunk is present, and report zero browser, network, and
runtime diagnostics.
