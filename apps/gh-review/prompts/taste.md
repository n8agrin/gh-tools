Review this PR for taste, through three lenses. The output is questions for the author, not verdicts. Every question must cite prior art in this repo with links to the exact files and lines. If you can't find evidence for a point, drop it. No opinions without evidence. Fewer, better questions beat many weak ones.

Consistency. For new or changed UI, find the closest existing surface of the same kind (another settings page, another modal, another table) and compare: shared components used versus hand-rolled ones, wording and capitalization, loading, empty and error states, and interactions like keyboard, focus and confirmation. For non-UI code, compare with the closest existing module of the same kind.

Simple first. List the new surface the PR adds: components, APIs and endpoints, tables and columns, feature flags, settings, and names users will see. For each, ask what the smallest version would be. Be strict on choices that are hard to undo (schema, public API, user-facing concepts) and lenient on easy ones. Flag any new abstraction with only one caller.

Right-sized fix. For fixes and refactors, search the repo for other places with the same pattern and count them. Many sites suggest a structural fix was warranted; a new abstraction with one caller suggests the plain fix would have been better. Report the count and link a few of the sites. Skip this lens for pure feature work and say so.

Links: prior art on the base branch uses the base link format given below; the PR's own code uses the head link format.

Only cite prior art that does the same job as the PR code (same kind of route, flow, layer). State in one clause what job both do, in the job field. A route that enforces a limit is not prior art for code that sets or stores one. Prior art can come from anywhere in the repo, including code outside this PR and other layers of its stack. Link the PR's own code with a label starting "PR:" and prior art with a label starting "Base:".

Before asking the author to share, merge or rename something, do three things. The last run got these wrong most often.

1. Count the neighbors. List the sibling files that do the same kind of job (every tool in the same tools directory, every function in the same client file) and count how many do it the PR's way versus the way you'd suggest. If most siblings do it the PR's way, the PR is following the local convention: drop the point. A finding built on one sibling is not a convention. Put the count in the siblings field, e.g. "3 of 4 tools in mcp/tools declare their own documentQuerySchema.pick".
2. Read the author's reason. Check the comments next to the PR code and the description. If the author already explains the choice, the question has to quote that reason and say why it doesn't hold; otherwise drop it. Put the reason in the author_reason field, or leave it empty when there is none.
3. Check the fix fits. For "share" or "extract" questions, say where the shared code would live and check that it would work as is: the signatures match, and the import doesn't reach into an unrelated module (a client for a different service, another package's internals). For "add an option" questions, check the option doesn't turn a clean return type into a union. If the fix needs more than the duplication it removes, drop it. Say how many lines are duplicated; a few lines of glue is not worth a question unless it encodes a contract that has to change in both places.

Keep every question to one sentence of at most 25 words, and its why to one sentence. Each lens note is one sentence. Give the PR file and line range each question is about in the file and lines fields; the page shows the question on that file.

A skeptic checks every comparison against the linked code afterwards and drops the ones that don't hold, so a weak comparison costs more than it's worth.
