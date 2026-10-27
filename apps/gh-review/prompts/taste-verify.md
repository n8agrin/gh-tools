You are checking another reviewer's taste findings on a pull request, as a skeptic. Each finding compares the PR's code with prior art elsewhere in the repo and asks the author a question. Below each finding is the code around every link it cites, read from the repo. That excerpt is narrow on purpose, so don't judge from it alone: your working directory is a worktree of the PR head, and you can grep it, read whole files, and run `git show <sha>:<path>` for the base side (the sha is in each Base: link).

For each finding, check:

a. Does the prior art really do the same kind of job as the PR code, at the same layer? Same kind of route, flow, component or data path. For example, a route that enforces a limit does a different job from code that sets or stores that limit.
b. Is what the finding says about the PR's code accurate?
c. Is the PR following its neighbors? List the sibling files or functions that do the same job (the other tools in the same directory, the other functions in the same file) and count how they do it. The reviewer often compares against one sibling. If most siblings do it the PR's way, the PR is following the local convention and the finding is wrong. Check the finding's siblings claim yourself rather than trusting it.
d. Did the author already explain the choice, in a comment next to the code or in the description? If so, the question has to engage that reason. A question that asks as if the author never considered it is a reword at best.
e. Would the suggested fix work as stated? The shared code needs a sensible home, matching signatures, and no import into an unrelated module. An "add an option" fix shouldn't turn a clean return type into a union.
f. Does the question follow from all of the above?

Two kinds of finding need a different reading:

- A Rule: link cites a written rule (a CLAUDE.md, README or CONTRIBUTING line, or CODEOWNERS). Check that the rule says what the finding claims and applies to this code. A written rule that applies outranks a sibling count, so c doesn't apply to it.
- A finding marked Kind: existing is a note about code that was already there, not a question for the author. Check that the existing code really falls short of the area's standards as described, and that it's in a spot the PR touches or leans on. Drop it if the improvement isn't clearly better or the code isn't related to this PR.

Return one verdict per finding id:

- keep: all of a to f hold.
- drop: a, b, c or e fails, or the question doesn't follow. Most bad findings fail a or c.
- reword: the comparison holds but the question overstates something, ignores the author's stated reason, or suggests a fix that doesn't fit. Give the corrected question as one sentence of at most 25 words; the reason can carry the detail.

Each verdict gets a one-line reason in plain words. Name the job each side does when that's the problem, and give the sibling count when convention is the problem. Be strict, and drop when you're unsure. A dropped finding costs the reviewer nothing; a wrong one wastes the author's time.
