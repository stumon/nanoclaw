---
name: mission-control
description: |
  Daily morning briefing auto-generator. Aggregates Google Calendar events, Gmail inbox highlights, weather forecast, and scheduled tasks into a formatted daily report. Use when the user asks for "morning briefing", "daily report", "today's overview", "mission control", "what's on my plate today", "daily summary", "morning update", or says "早报", "今日概览", "今天有什么安排", "每日简报". Can be scheduled to run automatically every morning.
---

# Mission Control

Generate a comprehensive daily morning briefing by aggregating multiple data sources.

## Data Sources

### 1. Calendar (via gog)

```bash
TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
TOMORROW=$(date -u -v+1d +%Y-%m-%dT00:00:00Z)
gog calendar events primary --from "$TODAY" --to "$TOMORROW" --json
```

### 2. Gmail Highlights (via gog)

```bash
gog gmail search "newer_than:1d is:important OR is:unread" --max 10 --json
```

### 3. Weather (via wttr.in)

```bash
curl -s "wttr.in/?format=%l:+%c+%t+%h+%w"
```

For detailed forecast:
```bash
curl -s "wttr.in/?format=v2&lang=zh"
```

### 4. Scheduled Tasks

Read the tasks snapshot from `data/tasks-snapshot.json` if available, or query the scheduler for today's pending tasks.

## Output Format

```
# Daily Briefing — [Date]

## Weather
[City]: [condition] [temp] | Humidity: [h] | Wind: [w]

## Today's Schedule
| Time | Event | Location |
|------|-------|----------|
| 09:00 | ... | ... |
| 14:30 | ... | ... |

## Email Highlights
- [sender]: [subject] — [1-line preview]
- [sender]: [subject] — [1-line preview]

## Pending Tasks
- [ ] [task description] (due: [time])

## Quick Notes
- [any notable items, reminders, or alerts]
```

## Scheduling

Set up auto-generation via NanoClaw task scheduler:

```
Schedule a daily task at 08:00 Beijing time:
"Generate my morning briefing and send it to me"
```

This uses `schedule_task` MCP tool with cron `0 0 * * *` (UTC, adjust for timezone).

## Customization

- Add/remove data sources by editing sections above
- Adjust email filter query for relevance
- Change weather location: replace `wttr.in/` with `wttr.in/CityName`
- Set `GOG_ACCOUNT` env var to avoid specifying account each time
