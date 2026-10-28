Review this PR for taste, through four lenses. The output is questions for the author, not verdicts. Every question must cite prior art in this repo with links to the exact files and lines. If you can't find evidence for a point, drop it. No opinions without evidence. Fewer, better questions beat many weak ones.

Consistency. For new or changed UI, find the closest existing surface of the same kind (another settings page, another modal, another table) and compare: shared components used versus hand-rolled ones, wording and capitalization, loading, empty and error states, and interactions like keyboard, focus and confirmation. For non-UI code, compare with the closest existing module of the same kind.

Simple first. List the new surface the PR adds: components, APIs and endpoints, tables and columns, feature flags, settings, and names users will see. For each, ask what the smallest version would be. Be strict on choices that are hard to undo (schema, public API, user-facing concepts) and lenient on easy ones. Flag any new abstraction with only one caller.

Right-sized fix. For fixes and refactors, search the repo for other places with the same pattern and count them. Many sites suggest a structural fix was warranted; a new abstraction with one caller suggests the plain fix would have been better. Report the count and link a few of the sites. Skip this lens for pure feature work and say so.

Area standards. Review as the maintainer of the part of the codebase this PR touches, someone who knows its standards and has to live with this code after it merges. Study the area before you judge it:
- Written rules first. Read CLAUDE.md, AGENTS.md, README.md and CONTRIBUTING.md in each touched directory and its parents up to the repo root, and the CODEOWNERS entries for the touched paths. A place where the PR breaks a written rule is the strongest question there is; link the rule's line with a label starting "Rule:".
- Then the unwritten ones: how the other files in the area handle errors, naming, tests, logging, data access and module layout. Only a pattern most of the area shares counts, with the sibling count in the siblings field.
- Ask about each place the PR diverges, and about improvements the maintainer would ask for before taking the code on.
- Separately, the maintainer may see that the existing code falls short of the area's own standards in a spot this PR touches or leans on. Give those kind "existing": they are notes for the reviewer, not asks of the author, so phrase them as an observation and name the code that could be better. At most 2.
The note says which area you reviewed and which written rules you found, or that it has none.

Links: prior art on the base branch uses the base link format given below; the PR's own code uses the head link format.

Only cite prior art that does the same job as the PR code (same kind of route, flow, layer). State in one clause what job both do, in the job field. A route that enforces a limit is not prior art for code that sets or stores one. Prior art can come from anywhere in the repo, including code outside this PR and other layers of its stack. Link the PR's own code with a label starting "PR:", prior art with a label starting "Base:", and a written rule with a label starting "Rule:" (base link format).

Before asking the author to share, merge or rename something, do three things. The last run got these wrong most often.

1. Count the neighbors. List the sibling files that do the same kind of job (every tool in the same tools directory, every function in the same client file) and count how many do it the PR's way versus the way you'd suggest. If most siblings do it the PR's way, the PR is following the local convention: drop the point. A finding built on one sibling is not a convention. Put the count in the siblings field, e.g. "3 of 4 tools in mcp/tools declare their own documentQuerySchema.pick".
2. Read the author's reason. Check the comments next to the PR code and the description. If the author already explains the choice, the question has to quote that reason and say why it doesn't hold; otherwise drop it. Put the reason in the author_reason field, or leave it empty when there is none.
3. Check the fix fits. For "share" or "extract" questions, say where the shared code would live and check that it would work as is: the signatures match, and the import doesn't reach into an unrelated module (a client for a different service, another package's internals). For "add an option" questions, check the option doesn't turn a clean return type into a union. If the fix needs more than the duplication it removes, drop it. Say how many lines are duplicated; a few lines of glue is not worth a question unless it encodes a contract that has to change in both places.

Every question has a kind: "author" for a question to the PR's author, "existing" for a note on code that was already there (Area standards only). Keep every question to one sentence of at most 25 words, and its why to one sentence. Each lens note is one sentence. Give the PR file and line range each question is about in the file and lines fields; the page shows the question on that file.

Show what the suggestion would look like. A question like "would a helper name this?" is hard to judge without seeing the helper, so whenever a question suggests a change to code (extract a helper, share a component, rename, call something else, add a state), fill the example field the way you'd answer a reviewer who asked "what would it replace?":
- before: the PR's code the suggestion would change, copied exactly from the PR head, starting with a comment line naming its file and lines, e.g. `// list-keys.ts:88-90`.
- after: that code once the suggestion is applied. For a new helper or shared piece, give its definition first, with a comment naming where it would live (e.g. `// list-keys.ts:41, beside selectionKey`), then the changed call site.
- replaces: two or three plain sentences. Say how many places the change touches (grep for them), what it leaves alone and why (tests that type the literal by hand, docs that spell out the shape), and how big the change is: a move or a behavior change, and so whether it's a nit.
Keep before and after to about 12 lines each, trimmed to the lines that change plus enough to place them; use `// ...` for lines left out. Use the file's own language. When a question isn't about a code change you can sketch (wording, a missing doc, a count of sites), leave all three empty rather than inventing one.

For example, for "Would a pinnedKey(index) helper beside selectionKey name the key template like the file's other generated keys?":
- before: `// list-keys.ts:88-90` then `key: pinned ? \`pinned_${items.indexOf(item)}\` : item.id,`
- after: `// list-keys.ts:41, beside selectionKey`, the four-line `pinnedKey(index: number)` function with a one-line doc comment, then `// list-keys.ts:88-90` and the ternary calling `pinnedKey(items.indexOf(item))`.
- replaces: "Replaces the one inline template in source, the ternary at :88-90. The two tests that type the literal stay as they are, like the sibling tests do for the other generated keys, and the README line that documents the shape could name the helper. It's a move, not a behavior change, so it's a nit."

A skeptic checks every comparison against the linked code afterwards and drops the ones that don't hold, so a weak comparison costs more than it's worth.
