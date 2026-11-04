// The opening book: every position reachable along a line of the lichess chess-openings TSVs counts as "in book",
// so the ply where a game leaves theory is the first non-book position. The keys come prebuilt as book_keys.txt
// (one fen_key per line, written by scripts/build_web.js from data/book), which the app loads once at start.

let keys = new Set();

/** Load book_keys.txt's text. */
export function loadBook(text) {
  keys = new Set(text.split('\n'));
}

/** Use these keys as the book (tests). */
export function setBook(iterable) {
  keys = new Set(iterable);
}

export const isBook = key => keys.has(key);
