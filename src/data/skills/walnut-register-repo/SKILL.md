---
name: walnut-register-repo
description: >-
  Deep-explore current codebase and register it as a Walnut repository.
  Produces a rich profile: what the project does, architecture overview,
  key components, tech stack, and common workflows.
  Use when user says "register repo", "add this repo", "/walnut-register-repo",
  or wants to create a Walnut repository profile for the current project.
---

# Register Repository

Explore this codebase and produce a rich, structured repository profile.

## Goal

Create a YAML file at `~/.open-walnut/repositories/{slug}.yaml` that genuinely captures what this project is, how it works, and how to work with it. Someone reading this profile should understand the project without opening a single file.

## How to explore

Start with a quick broad scan — directory structure, README, package manifest — to get the lay of the land. Based on what you find, decide what needs deeper investigation. Use sub-agents for parallel deep dives into areas you identify as important.

You decide the exploration strategy. A React SPA needs different investigation than a microservice or a CLI tool. Go where the interesting stuff is.

**Quality bar**: "A web application built with React" is useless. "Real-time collaborative document editor with CRDTs for conflict resolution, React frontend with ProseMirror, and WebSocket sync server" is what we want.

## Output Format

Write the YAML to `~/.open-walnut/repositories/{slug}.yaml`:

```yaml
name: Project Name
description: >-
  1-3 sentences. Specific about what it does, not generic.
  This is what the Repositories page and every listing shows.
tech_stack: [Lang, Framework, DB, ...]
hosts:
  local:
    path: /absolute/path   # use current working directory

overview: |
  ## What
  What this project does — be specific.

  ## Why
  Why it exists — what problem, who uses it.

  ## How
  High-level how it works — the 30-second explanation.

architecture: |
  Major components, how they connect, key directories.
  An agent reading this should understand the codebase layout.

common_commands: |
  The commands a new developer needs on day one.
```

**Required**: name, description, hosts (at least one with path)
**Important**: overview and architecture. Nothing injects them into a session automatically, so write them for a person, and for the agent that reads the profile on purpose when a task names a repo it does not know. Anything a session must know unprompted belongs in that repo's own `AGENTS.md` / `CLAUDE.md` or in a skill.

The complete YAML format spec with examples is in `references/yaml-format.md` next to this SKILL.md file.

## After writing

Validate with the script next to this SKILL.md:
```
python3 {this_skill_dir}/scripts/validate-repo.py ~/.open-walnut/repositories/{slug}.yaml
```
(Replace `{this_skill_dir}` with the directory containing this SKILL.md file.)

Show the user the result. Don't ask a checklist of questions — just show it and ask if anything needs adjustment.
