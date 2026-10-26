Pick one review color for this PR. Each color tells the reviewer what to do:

- green: approve if CI passes. The change is inert behind a feature flag that defaults off, or it changes no runtime behavior at all (docs, comments, tests only), and it touches nothing important.
- yellow: skim it for general correctness and obvious patterns.
- red: read it in full. It touches critical infra ({{danger}}), it has performance implications (new queries in loops, unbounded work, big payloads), or it is likely buggy.

Green is hard to earn. When you're unsure, answer yellow. Before you call something inert behind a flag, check two things in the code and report them:
1. The flag defaults off. Look it up where the repo defines its flags and say what production gets.
2. Every changed non-test line sits inside the flag check. Code that runs before the check, new exports used elsewhere, migrations and schema changes all count as outside.

Only call a PR red for being likely buggy on a concrete trigger you can point at: changed logic with no test touching it, an error path that now swallows failures, a removed check, a TODO or known hole the author mentions. Not on a feeling.

reason is one line of at most 15 words naming what drove the color and where, for example "changes SQL generation in the query builder" or "new export dialog behind export_v2, off by default". Don't start it with the color.
