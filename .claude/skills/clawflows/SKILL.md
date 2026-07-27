---
name: clawflows
description: |
  Multi-step automation workflow orchestration for NanoClaw. Define, run, and schedule complex workflows that chain skills and actions together. Use when the user asks to "create a workflow", "automate a multi-step process", "chain tasks together", "build an automation", "run a sequence of steps", or says "工作流", "自动化流程", "多步骤任务", "流程编排", "自动化". Supports serial/parallel execution, conditionals, and variable passing between steps.
---

# ClawFlows

Multi-step workflow orchestration for NanoClaw. Chain skills and actions into automated sequences.

## Workflow Definition (YAML)

```yaml
name: morning-routine
description: Daily morning briefing workflow
trigger: cron "0 0 * * *"  # UTC 00:00 = Beijing 08:00

steps:
  - id: weather
    action: shell
    command: 'curl -s "wttr.in/Beijing?format=%c+%t"'

  - id: calendar
    action: shell
    command: 'gog calendar events primary --from "$TODAY" --to "$TOMORROW" --json'

  - id: emails
    action: shell
    command: 'gog gmail search "newer_than:1d is:unread" --max 5 --json'

  - id: compile
    action: prompt
    input: |
      Generate a morning briefing from:
      Weather: ${weather.output}
      Calendar: ${calendar.output}
      Emails: ${emails.output}

  - id: send
    action: shell
    command: 'echo "${compile.output}"'
    # Or send via messaging channel
```

## Actions

| Action | Description | Parameters |
|--------|-------------|------------|
| `shell` | Run a shell command | `command` |
| `prompt` | Send prompt to Claude | `input`, optional `model` |
| `skill` | Invoke a NanoClaw skill | `skill_name`, `input` |
| `condition` | Branch based on expression | `if`, `then`, `else` |
| `parallel` | Run steps concurrently | `steps[]` |
| `notify` | Send message to user | `channel`, `message` |

## Variable Passing

Each step's output is accessible by subsequent steps:

- `${step_id.output}` — full output of a previous step
- `${step_id.exit_code}` — exit code (for shell actions)
- `${ENV_VAR}` — environment variable
- `${TODAY}`, `${TOMORROW}` — date helpers (ISO format)

## Conditionals

```yaml
- id: check
  action: condition
  if: "${weather.output} contains 'Rain'"
  then:
    - id: rain_alert
      action: notify
      message: "Bring an umbrella today!"
  else:
    - id: sunny
      action: notify
      message: "Clear skies today."
```

## Parallel Execution

```yaml
- id: gather_data
  action: parallel
  steps:
    - id: source_a
      action: shell
      command: "curl -s https://api-a.example.com/data"
    - id: source_b
      action: shell
      command: "curl -s https://api-b.example.com/data"
```

## Execution

Run a workflow by describing it to NanoClaw:

1. **Ad-hoc**: "Run my morning-routine workflow"
2. **Scheduled**: Use `schedule_task` MCP tool with the workflow as prompt
3. **Triggered**: React to incoming messages matching a pattern

## Error Handling

- By default, workflow stops on first error
- Add `on_error: continue` to a step to skip failures
- Add `retries: 3` for automatic retry with backoff
- Failed step output includes error message in `${step_id.error}`

## Built-in Templates

See [references/workflow-examples.md](references/workflow-examples.md) for ready-to-use templates:
- Morning briefing
- Data scraping pipeline
- Report generation
- Content publishing flow
