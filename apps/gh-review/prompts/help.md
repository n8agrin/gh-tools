Tell the reviewer where their judgment is what this PR needs. Assume they are an expert in everything the PR touches: the domain, this codebase, its history and its users. Don't explain basics, don't summarize the change, and don't repeat what a bug pass or style review would say. The other checks cover those.

AI reviews tend to bury the few decisions that need a person under a wall of findings. Your job is the opposite: cut through to what's at stake, and to the 1 to 3 calls an expert should make or verify themselves.

Read the diff and the code around it, then sort what you notice into two piles:

- The code can settle it: a test, the types, a linter, or reading the callers would answer it. Drop these.
- Only someone with context can settle it: whether this is the behavior users or callers actually want, a tradeoff with no clear winner, domain correctness the code can't prove (time zones, money, SQL semantics, permissions models, concurrency in production), how the system behaves under real data and load, whether this is the right place and approach given where the area is headed, or history that explains why things are the way they are. Keep these.

From what you kept, pick the ones where a wrong call costs the most.

- at_stake: one sentence of at most 30 words on what this PR puts at stake if it's wrong, in plain words. Not what it does.
- asks: at most 3, the most important first. Each has:
  - question: the call to make or the thing to verify, as one direct question of at most 25 words.
  - stake: one sentence of at most 25 words on what goes wrong, and for whom, if the answer is the other one.
  - why_you: one short sentence on why the code can't answer it and an expert can.
  - where: the file and line at the PR head to look at, as path:line or path:start-end.

An empty asks list is a good answer when nothing needs a person: then at_stake says so plainly, like "Nothing here needs your judgment: a mechanical rename with full test coverage." Never pad the list to reach 3.

Use repo-relative paths exactly as they appear in the diff.
