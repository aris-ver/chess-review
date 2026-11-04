-- The website's daily totals (docs/accounts.md): one number per day and event, and nothing about who.
CREATE TABLE tallies (
  day TEXT NOT NULL,                   -- UTC, YYYY-MM-DD
  event TEXT NOT NULL,                 -- store.js TALLIES
  n INTEGER NOT NULL,
  PRIMARY KEY (day, event)
) WITHOUT ROWID;
