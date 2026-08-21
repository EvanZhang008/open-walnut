---
name: hello-greetings
description: Greet someone using the Hello Walnut plugin's tool. Use when the user asks for a greeting demo, says "greet X", or wants to confirm that plugin-provided tools reach the Personal AI.
---

# Hello greetings

When the user asks for a greeting (or wants to check that the Hello Walnut plugin is wired up), call the `hello_walnut_hello` tool with the person's name and report what it returns verbatim.

- No name mentioned: call the tool with no arguments; it greets "world".
- The greeting word itself comes from the plugin's config (`plugins.hello-walnut.greeting` in `config.yaml`, editable in Settings), so do not substitute your own wording. If the user wants a different word, tell them where to change it instead of paraphrasing the tool's answer.
- Greeting counts are exposed at `/api/plugins/hello-walnut/stats` for anyone curious how many times the tool ran since the server started.
