---
name: pdf-chat
description: |
  Conversational Q&A with PDF documents. Extract text from PDFs and answer questions about their content through multi-turn dialogue. Use when the user asks to "chat with a PDF", "ask questions about this PDF", "what does this document say about X", "PDF Q&A", "read this PDF and answer", "analyze this document", or says "和PDF对话", "问PDF问题", "分析这个文档", "这个PDF里说了什么". Supports multi-PDF comparison and table extraction.
---

# PDF Chat+

Interactive Q&A with PDF documents. Extract content, then answer questions conversationally.

## Workflow

### Step 1: Extract Text

For text-based PDFs:

```python
import pdfplumber

def extract_pdf(path):
    text_pages = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text()
            if text:
                text_pages.append(f"[Page {i+1}]\n{text}")
    return "\n\n".join(text_pages)
```

For scanned PDFs (OCR fallback):

```bash
pdftotext -layout input.pdf /dev/stdout
```

### Step 2: Load into Context

After extraction, hold the text in working memory. For large PDFs (>50 pages), chunk by sections or page ranges and load relevant chunks on demand.

Chunking strategy:
- Small PDF (<20 pages): load full text
- Medium PDF (20-100 pages): load by chapter/section headers
- Large PDF (100+ pages): extract table of contents first, then load sections as needed

### Step 3: Answer Questions

Use the extracted text as context to answer user questions. Always cite page numbers.

Response format:
```
Based on the document:

[Answer with specific details]

(Source: Page X, Section Y)
```

## Table Extraction

When questions involve tabular data:

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            # Convert to structured format for analysis
            headers = table[0]
            rows = table[1:]
```

Present tables in markdown format for readability.

## Multi-PDF Comparison

When comparing multiple documents:

1. Extract text from each PDF separately
2. Label each with a short identifier (e.g., "Doc A", "Doc B")
3. Answer comparative questions citing both sources

Format:
```
Comparing the two documents:

**Doc A** states: [content] (Page X)
**Doc B** states: [content] (Page Y)

Key differences:
1. ...
2. ...
```

## Tips

- Always tell the user which pages you're referencing
- For form-based PDFs, use the `pdf` skill's form-filling capabilities
- If extraction quality is poor, suggest the user try OCR or a different extraction method
- Support follow-up questions — maintain conversation context about the loaded PDF
- For financial/legal PDFs, be extra careful about accuracy and always quote directly
