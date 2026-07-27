---
name: youtube-summarizer
description: |
  YouTube video summarizer with structured output. Extracts transcripts, generates key takeaways, timestamps, and notable quotes. Use when the user asks to "summarize a YouTube video", "transcribe YouTube", "what's this video about", "YouTube summary", "watch this video for me", "extract key points from video", or mentions any YouTube URL. Also handles channel search and playlist summarization. Triggers on: youtube summary, video summary, summarize video, youtube transcript, video takeaways, video notes, youtube notes, watch and summarize, video key points.
---

# YouTube Summarizer+

Enhanced YouTube video summarization powered by the `summarize` CLI.

## Prerequisites

- `summarize` CLI: `brew install steipete/tap/summarize`
- `yt-dlp`: `brew install yt-dlp` (reliable subtitle extraction fallback)
- For search: Tavily API key (`TAVILY_API_KEY` in .env)
- Optional: `APIFY_API_TOKEN` for summarize's built-in YouTube fallback

## Workflow

### 1. Single Video Summary

```bash
summarize "https://youtu.be/VIDEO_ID" --youtube auto --model google/gemini-3-flash-preview
```

### 2. Transcript Only

```bash
summarize "https://youtu.be/VIDEO_ID" --youtube auto --extract-only
```

### 3. Find Latest Video by Topic

When user asks for "latest video from X about Y", use this sequence:

1. Search with Tavily: `./scripts/search "site:youtube.com CHANNEL_NAME TOPIC latest 2025 2026"`
2. Pick the most relevant URL from results
3. Run `summarize` on that URL

### 4. Playlist / Multiple Videos

Process each URL sequentially:

```bash
for url in URL1 URL2 URL3; do
  summarize "$url" --youtube auto --length medium
done
```

## Output Format

Structure every video summary as:

```
## [Video Title]
Channel: [name] | Duration: [if known] | Date: [if known]

### Key Takeaways
1. ...
2. ...
3. ...

### Notable Quotes
> "Quote text" — [timestamp if available]

### Detailed Summary
[2-4 paragraph summary organized by topic]

### Action Items (if applicable)
- ...
```

## Fallback: yt-dlp Transcript Extraction

When `summarize --youtube auto` fails (no APIFY token, video blocked, etc.), use yt-dlp:

```bash
# Extract auto-generated subtitles
yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "/tmp/video-name" "VIDEO_URL"

# Clean VTT to plain text (remove timestamps and duplicates)
python3 -c "
import re
with open('/tmp/video-name.en.vtt') as f:
    content = f.read()
content = re.sub(r'WEBVTT\nKind:.*\nLanguage:.*\n', '', content)
content = re.sub(r'\d{2}:\d{2}:\d{2}\.\d{3}\s*-->.*\n', '', content)
content = re.sub(r'<[^>]+>', '', content)
lines = [l.strip() for l in content.split('\n') if l.strip()]
deduped = []
prev = ''
for line in lines:
    if line != prev:
        deduped.append(line)
        prev = line
text = ' '.join(deduped)
text = re.sub(r'\s+', ' ', text).strip()
with open('/tmp/video-transcript.txt', 'w') as f:
    f.write(text)
print(f'{len(text)} chars, ~{len(text.split())} words')
"

# Then summarize the transcript file
summarize /tmp/video-transcript.txt --model MODEL --length long
```

## Tips

- Use `--length short` for quick overview, `--length long` for deep dive
- If transcript extraction fails with summarize, use yt-dlp fallback above
- For non-English videos, summarize will auto-detect and translate
- For Chinese output, add instruction: "Please summarize in Chinese (中文)"
- Huge transcripts: summarize first, then ask user which section to expand
- yt-dlp supports `--sub-lang zh-Hans,en` for multiple language subtitles
