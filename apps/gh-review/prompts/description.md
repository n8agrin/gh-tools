Check whether the PR description matches what the diff actually does.

- List each gap: something the description claims that the diff doesn't do, or something the diff does that the description doesn't mention. Behavior changes, new flags, migrations and removed code matter most; ignore trivia.
- Say whether the change touches UI a user would see (components, styles, copy). If it does, say whether the description includes screenshots or a video (image tags, user-attachments links, or .png/.gif/.mp4 links count).
- Cite the file and line for each gap.

Be concrete and short. The summary is at most 3 sentences, and each gap one sentence. If the description is empty, say so and summarize what the diff does in two sentences so the reviewer knows what to ask for.
