# A context directory

Templates. **Copy this directory somewhere outside the repository**, point
`AGENT_CONTEXT_DIR` at the copy, and fill it in — what goes in it is yours, and
nothing here should ever come back as a diff.

The worker reads every flat `.md` and `.json` file directly in the directory,
in sorted order, and appends each one to the prompt under its own file name,
between the shipped contract and the day's instruction. That is the whole
convention. There is no schema, no required file, and no name the code knows:
`standing.md` and `blocklist.md` below are a starting shape, not an interface.
Delete them, rename them, add a `rotation.json` — the worker does not care.

What it does not read:

- **subdirectories**, `briefs/` in particular. The worker writes that one when
  `AGENT_WRITE_BRIEFS` is on, and a run that read its own output back would grow
  the prompt by a section a day forever.
- anything that is not `.md` or `.json`. A directory of notes also holds images,
  attachments and editor lock files, and none of those are something to put in
  front of a language model.
- more than 64 KiB of any one file. Past that it is cut and the model is told
  so, in a comment it can see.

A worker with no context directory at all files a perfectly good page from the
contract alone. This is where continuity goes, not correctness.

Two things worth knowing before you point this at a real vault:

- **The mount is read-only by default.** The worker only writes if you both set
  `AGENT_WRITE_BRIEFS=1` and change the mount in `agent/compose.yaml` to `:rw`.
- **Do not point `AGENT_CONTEXT_DIR` at this directory in the repository.** This
  file would go into the prompt too, and you would be editing tracked files to
  say private things.
