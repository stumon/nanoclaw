---
name: obsidian-integration
description: |
  AI-powered Obsidian vault management. Read, write, search, and organize markdown notes in an Obsidian vault. Use when the user asks to "manage my notes", "search my vault", "create a note", "find notes about X", "obsidian", "daily note", "knowledge base", or says "笔记管理", "搜索笔记", "创建笔记", "知识库", "Obsidian". Supports daily notes, tag management, backlink exploration, and full-text search.
---

# Obsidian Integration+

AI-powered management of Obsidian vaults. All notes are plain markdown files — no Obsidian API needed.

## Setup

Set the vault path in environment:

```bash
export OBSIDIAN_VAULT_PATH="$HOME/Documents/Obsidian Vault"
```

Or configure in `.env`:
```
OBSIDIAN_VAULT_PATH=/path/to/your/vault
```

If not set, prompt the user for their vault location on first use.

## Core Operations

### Search Notes

Full-text search across vault:

```bash
rg -l "search term" "$OBSIDIAN_VAULT_PATH" --type md
```

Search by tag:

```bash
rg -l "#tagname" "$OBSIDIAN_VAULT_PATH" --type md
```

Search by backlink:

```bash
rg -l "\[\[NoteName\]\]" "$OBSIDIAN_VAULT_PATH" --type md
```

### Create Note

Write a new markdown file to the vault:

```bash
cat > "$OBSIDIAN_VAULT_PATH/NoteName.md" << 'EOF'
---
created: YYYY-MM-DD
tags: [tag1, tag2]
---

# Note Title

Content here...
EOF
```

### Daily Note

Create or append to today's daily note:

```bash
DAILY_DIR="$OBSIDIAN_VAULT_PATH/Daily Notes"
mkdir -p "$DAILY_DIR"
TODAY=$(date +%Y-%m-%d)
DAILY_FILE="$DAILY_DIR/$TODAY.md"
```

Template for new daily note:
```markdown
---
created: YYYY-MM-DD
tags: [daily]
---

# YYYY-MM-DD

## Tasks
- [ ] 

## Notes


## Journal

```

### Read Note

```bash
cat "$OBSIDIAN_VAULT_PATH/path/to/note.md"
```

### List All Tags

```bash
rg -o '#[a-zA-Z0-9_/]+' "$OBSIDIAN_VAULT_PATH" --type md --no-filename | sort -u
```

### Find Orphan Notes (no backlinks)

```bash
for f in "$OBSIDIAN_VAULT_PATH"/*.md; do
  name=$(basename "$f" .md)
  count=$(rg -c "\[\[$name\]\]" "$OBSIDIAN_VAULT_PATH" --type md 2>/dev/null | wc -l)
  if [ "$count" -eq 0 ]; then echo "Orphan: $name"; fi
done
```

## Conventions

- Frontmatter: YAML with `created`, `tags`, optional `aliases`
- Links: use `[[WikiLink]]` style
- Tags: `#tag` or `#parent/child` hierarchy
- Daily notes folder: `Daily Notes/`
- Templates folder: `Templates/`
- Attachments: `Attachments/`

## Tips

- Always preserve existing frontmatter when editing notes
- When creating links, check if the target note exists first
- For large vaults (1000+ notes), use `rg` instead of reading all files
- Respect `.obsidian/` directory — never modify Obsidian config files
