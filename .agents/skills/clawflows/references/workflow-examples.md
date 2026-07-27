# ClawFlows Workflow Examples

## 1. Morning Briefing

```yaml
name: morning-briefing
description: Comprehensive daily briefing
trigger: cron "0 0 * * 1-5"

steps:
  - id: weather
    action: shell
    command: 'curl -s "wttr.in/?format=%l:+%c+%t+%h"'

  - id: calendar
    action: shell
    command: |
      TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
      TOMORROW=$(date -u -v+1d +%Y-%m-%dT00:00:00Z)
      gog calendar events primary --from "$TODAY" --to "$TOMORROW" --json

  - id: emails
    action: shell
    command: 'gog gmail search "newer_than:1d is:unread" --max 10 --json'

  - id: compile
    action: prompt
    input: |
      Create a morning briefing in Chinese. Data:
      Weather: ${weather.output}
      Calendar: ${calendar.output}
      Emails: ${emails.output}

  - id: deliver
    action: notify
    channel: default
    message: "${compile.output}"
```

## 2. Web Content Monitor

```yaml
name: content-monitor
description: Monitor a URL for changes and alert
trigger: interval 3600000

steps:
  - id: fetch
    action: shell
    command: 'curl -s "https://example.com/page" | md5'

  - id: compare
    action: shell
    command: |
      PREV=$(cat /tmp/content-hash.txt 2>/dev/null || echo "none")
      echo "${fetch.output}" > /tmp/content-hash.txt
      [ "$PREV" != "${fetch.output}" ] && echo "CHANGED" || echo "SAME"

  - id: alert
    action: condition
    if: "${compare.output} contains 'CHANGED'"
    then:
      - id: notify_change
        action: notify
        message: "Content at https://example.com/page has changed!"
```

## 3. Report Generation

```yaml
name: weekly-report
description: Generate and email weekly summary
trigger: cron "0 2 * * 1"

steps:
  - id: gather_metrics
    action: parallel
    steps:
      - id: gmail_stats
        action: shell
        command: 'gog gmail search "newer_than:7d" --max 100 --json | wc -l'
      - id: calendar_stats
        action: shell
        command: |
          WEEK_AGO=$(date -u -v-7d +%Y-%m-%dT00:00:00Z)
          NOW=$(date -u +%Y-%m-%dT23:59:59Z)
          gog calendar events primary --from "$WEEK_AGO" --to "$NOW" --json

  - id: generate
    action: prompt
    input: |
      Generate a weekly productivity report:
      Emails processed: ${gmail_stats.output}
      Meetings: ${calendar_stats.output}

  - id: send_report
    action: shell
    command: |
      echo "${generate.output}" > /tmp/weekly-report.md
      gog gmail send --to me@example.com --subject "Weekly Report" --body-file /tmp/weekly-report.md
```

## 4. Research Pipeline

```yaml
name: research-topic
description: Research a topic and compile findings

steps:
  - id: search
    action: shell
    command: './scripts/search "${TOPIC}" 10'

  - id: summarize_results
    action: prompt
    input: |
      Analyze these search results and identify the top 3 most relevant sources:
      ${search.output}

  - id: deep_dive
    action: skill
    skill_name: summarize
    input: "${summarize_results.output}"

  - id: compile
    action: prompt
    input: |
      Create a comprehensive research brief on "${TOPIC}":
      ${deep_dive.output}
```
