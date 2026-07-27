---
name: job-auto-apply
description: |
  Automated job search and application on LinkedIn and Boss直聘. Search positions, generate tailored resumes and cover letters, and auto-apply via browser automation. Use when the user asks to "find jobs", "auto apply for jobs", "job search", "apply to positions", "job hunting automation", or says "自动投递简历", "找工作", "求职自动化", "海投", "投递简历", "LinkedIn投递", "Boss直聘投递". Supports filtering by keywords, location, salary range, and tracking application status.
---

# Job Auto-Apply

Automated job search and application for LinkedIn and Boss直聘.

## Setup

### Resume

Place your base resume at `data/resume.md` (markdown format). The system will tailor it per application.

Optional: `data/resume.pdf` for direct upload.

### Configuration

```bash
# LinkedIn credentials (for browser automation)
LINKEDIN_EMAIL=your@email.com
LINKEDIN_PASSWORD=your_password

# Boss直聘 (cookie-based auth)
BOSS_COOKIE="your_boss_zhipin_cookie"

# Preferences
JOB_KEYWORDS="software engineer,backend developer"
JOB_LOCATION="Beijing,Shanghai,Remote"
JOB_SALARY_MIN=30000
JOB_EXPERIENCE="3-5 years"
```

## Workflow

### 1. Job Search

#### LinkedIn

Use Playwright browser automation:

```
1. Navigate to linkedin.com/jobs
2. Enter search keywords and location
3. Apply filters (date posted, experience level, remote)
4. Extract job listings: title, company, location, salary, URL
5. Save to data/job-listings.json
```

#### Boss直聘

```
1. Navigate to zhipin.com
2. Search with keywords and city filter
3. Extract listings: position, company, salary range, requirements
4. Save to data/job-listings.json
```

### 2. Job Filtering

Score and rank jobs based on:
- Keyword match in title and description
- Salary range alignment
- Location preference
- Company size/reputation
- Skills match against resume

### 3. Resume/Cover Letter Generation

For each target job:

1. Read `data/resume.md` as base
2. Analyze job description for key requirements
3. Generate tailored cover letter emphasizing relevant experience
4. Save to `data/applications/{company}-{date}/`

```
data/applications/
  bytedance-2026-03-16/
    cover-letter.md
    resume-tailored.md
    job-description.txt
```

### 4. Auto-Apply (Browser Automation)

Uses Playwright (via browser-use skill) for application submission:

**LinkedIn Easy Apply:**
```
1. Open job listing URL
2. Click "Easy Apply"
3. Fill form fields from resume data
4. Upload resume PDF
5. Submit application
6. Log result
```

**Boss直聘:**
```
1. Open position page
2. Click "立即沟通" or "投递简历"
3. Send greeting message (customized per job)
4. Log result
```

### 5. Application Tracking

Track all applications in `data/job-applications.json`:

```json
{
  "applications": [
    {
      "id": "uuid",
      "platform": "linkedin",
      "company": "Company Name",
      "position": "Software Engineer",
      "url": "https://...",
      "applied_at": "2026-03-16T10:00:00Z",
      "status": "applied",
      "notes": ""
    }
  ]
}
```

Status values: `saved`, `applied`, `replied`, `interview`, `rejected`, `offer`

### 6. Daily Summary

Generate a daily application report:

```
## Job Application Report — YYYY-MM-DD

### Today's Activity
- Applications sent: X
- Responses received: Y
- Interviews scheduled: Z

### Applications
| Company | Position | Platform | Status |
|---------|----------|----------|--------|
| ... | ... | LinkedIn | Applied |

### Pipeline
- Saved: X positions
- Applied: Y positions
- In progress: Z interviews
```

## Safety

- Rate limit: max 20 applications per day per platform
- Random delays (30-120s) between applications to avoid detection
- Always save a local copy before submitting
- Never auto-apply without user reviewing the first 2-3 applications
- Stop and alert on any CAPTCHA or account restriction

## Commands

- "搜索职位 [关键词]" — search and display matching jobs
- "投递 [company/url]" — apply to a specific job
- "海投 [N]" — batch apply to top N matched jobs
- "投递报告" — show application summary
- "更新简历" — refresh base resume
