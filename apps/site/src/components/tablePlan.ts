// The table illustration: a round table seen from above with four chairs, on a 48-unit grid
// (centre 24, 24), drawn by the hero table (TableArt), the privacy flow markers and og.png.
// Chairs: annulus r 15 to 22, cut by parallel gaps 11 wide on the diagonals, corners filleted
// at r 2. Table: r 10. Written by scripts/make-mark.mjs; never edit the numbers by hand.
export const CHAIR_N = "M14.78 7A2 2 0 0 1 15.41 3.75A22 22 0 0 1 32.59 3.75A2 2 0 0 1 33.22 7L30.9 9.32A2 2 0 0 1 28.84 9.8A15 15 0 0 0 19.16 9.8A2 2 0 0 1 17.1 9.32Z"
export const CHAIR_W = "M7 33.22A2 2 0 0 1 3.75 32.59A22 22 0 0 1 3.75 15.41A2 2 0 0 1 7 14.78L9.32 17.1A2 2 0 0 1 9.8 19.16A15 15 0 0 0 9.8 28.84A2 2 0 0 1 9.32 30.9Z"
export const CHAIR_S = "M33.22 41A2 2 0 0 1 32.59 44.25A22 22 0 0 1 15.41 44.25A2 2 0 0 1 14.78 41L17.1 38.68A2 2 0 0 1 19.16 38.2A15 15 0 0 0 28.84 38.2A2 2 0 0 1 30.9 38.68Z"
export const PRIVATE_CHAIR = "M41 14.78A2 2 0 0 1 44.25 15.41A22 22 0 0 1 44.25 32.59A2 2 0 0 1 41 33.22L38.68 30.9A2 2 0 0 1 38.2 28.84A15 15 0 0 0 38.2 19.16A2 2 0 0 1 38.68 17.1Z"
// The east chair inset by 2.25 on every side; cut out with even-odd to make it hollow.
export const PRIVATE_HOLE = "M42.33 16.63A19.75 19.75 0 0 1 42.33 31.37L40.38 29.42A17.25 17.25 0 0 0 40.38 18.58Z"
