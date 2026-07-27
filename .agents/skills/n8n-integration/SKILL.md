---
name: n8n-integration
description: |
  Connect NanoClaw with n8n workflow automation platform. Trigger n8n workflows, receive webhooks, and manage automations via n8n API. Use when the user asks to "connect n8n", "trigger n8n workflow", "n8n integration", "webhook automation", "connect SaaS tools", or says "n8n集成", "连接n8n", "工作流自动化", "webhook". Requires a running n8n instance (local or cloud).
---

# n8n Integration+

Connect NanoClaw with n8n for SaaS workflow automation.

## Setup

### Environment Variables

```bash
N8N_API_URL=http://localhost:5678    # or https://your-n8n.cloud
N8N_API_KEY=your-n8n-api-key
```

Get API key: n8n Settings > API > Create API Key

### Install n8n (if needed)

Local Docker:
```bash
docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n
```

Or via npm:
```bash
npm install -g n8n && n8n start
```

## API Operations

### List Workflows

```bash
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_API_URL/api/v1/workflows" | jq '.data[] | {id, name, active}'
```

### Execute Workflow

```bash
curl -s -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  "$N8N_API_URL/api/v1/workflows/$WORKFLOW_ID/execute" \
  -d '{"data": {"key": "value"}}'
```

### Get Execution Result

```bash
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_API_URL/api/v1/executions/$EXECUTION_ID"
```

### Activate/Deactivate Workflow

```bash
curl -s -X PATCH -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  "$N8N_API_URL/api/v1/workflows/$WORKFLOW_ID" \
  -d '{"active": true}'
```

## Webhook Integration

### NanoClaw to n8n (outbound)

Trigger n8n webhook nodes from NanoClaw:

```bash
curl -s -X POST "http://localhost:5678/webhook/YOUR_WEBHOOK_PATH" \
  -H "Content-Type: application/json" \
  -d '{"source": "nanoclaw", "event": "message", "data": "..."}'
```

### n8n to NanoClaw (inbound)

n8n can trigger NanoClaw via IPC or scheduled tasks. Set up an HTTP Request node in n8n pointing to NanoClaw's local endpoint.

## Common Patterns

### 1. Forward Messages to CRM

When NanoClaw receives a message, trigger n8n to log it in your CRM:

```bash
curl -s -X POST "$N8N_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{\"contact\": \"$SENDER\", \"message\": \"$MESSAGE\", \"timestamp\": \"$(date -Iseconds)\"}"
```

### 2. Scheduled Data Sync

Use NanoClaw scheduler to trigger n8n data sync workflows on a cron schedule.

### 3. Alert Pipeline

n8n monitors external services -> fires webhook to NanoClaw -> NanoClaw sends alert via WhatsApp/Telegram.

## Troubleshooting

- Verify n8n is running: `curl -s $N8N_API_URL/healthz`
- Check API key permissions: must have `workflow:read`, `workflow:execute`
- Webhook URLs are case-sensitive
- For cloud n8n, ensure CORS allows your NanoClaw host
