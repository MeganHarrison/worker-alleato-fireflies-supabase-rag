# Fireflies Ingest Worker

A Cloudflare Worker that automatically syncs meeting transcripts from Fireflies.ai and stores them in Supabase. This is an **ingest-only system** that handles transcript fetching, storage, and metadata management. Vector embeddings and search are handled by a separate vectorizer worker.

## Table of Contents

- [What This System Does](#what-this-system-does)
- [How It Works](#how-it-works)
- [Data Storage](#data-storage)
- [How It's Triggered](#how-its-triggered)
- [API Endpoints](#api-endpoints)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Usage Examples](#usage-examples)
- [Monitoring](#monitoring)

## What This System Does

### ✅ This Worker Handles

1. **Fireflies Integration**: Fetches transcripts via GraphQL API
2. **Metadata Extraction**: Extracts title, date, participants, keywords, action items
3. **File Storage**: Saves transcripts as Markdown files in Supabase Storage
4. **Database Records**: Stores metadata in PostgreSQL `documents` table
5. **Webhook Processing**: Handles real-time Fireflies webhook events
6. **Batch Sync**: Processes multiple transcripts in parallel batches

### ❌ This Worker Does NOT Handle

- **Vector Embeddings**: Delegated to separate vectorizer worker
- **Transcript Chunking**: Handled by vectorizer worker
- **Semantic Search**: Requires vectorizer worker to populate embeddings
- **Chat/Answer Generation**: Pure ingest system, not a chatbot
- **Real-time Transcription**: Only processes completed Fireflies transcripts

## How It Works

### Processing Pipeline

```
1. Trigger (Cron/Webhook/API) 
        ↓
2. Fetch from Fireflies API
        ↓
3. Extract Metadata
        ↓
4. Generate Markdown
        ↓
5. Upload to Supabase Storage
        ↓
6. Save to PostgreSQL
        ↓
7. Trigger Vectorizer Worker (Optional)
```

### Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Fireflies.ai   │────▶│ Ingest Worker    │────▶│    Supabase     │
│   (GraphQL)     │     │  (This System)   │     │ PostgreSQL +    │
└─────────────────┘     │                  │     │ Storage         │
                        │ - Fetch          │     └─────────────────┘
                        │ - Transform      │              │
                        │ - Store          │              │
                        └──────────────────┘              │
                                │                         │
                                ▼                         ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │ Vectorizer Worker│     │ Stored Files    │
                        │ (Separate System)│     │ meetings/       │
                        └──────────────────┘     │ transcripts/    │
                                                 └─────────────────┘
```

## Data Storage

### 🗄️ PostgreSQL Tables (via Supabase)

#### `documents` Table
**Purpose**: Stores meeting metadata and full content  
**Written by**: This ingest worker  

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Auto-generated primary key |
| title | TEXT | Meeting title from Fireflies |
| source | TEXT | Always "fireflies" |
| content | TEXT | Full markdown transcript |
| category | TEXT | Always "meeting" |
| participants | TEXT[] | Array of participant emails |
| summary | TEXT | Meeting overview |
| action_items | TEXT[] | Array of action items |
| bullet_points | TEXT[] | Array of key points |
| fireflies_id | TEXT | Original Fireflies transcript ID (unique) |
| fireflies_link | TEXT | Link to view in Fireflies app |
| date | TIMESTAMP | Meeting date and time |
| metadata | JSONB | Additional structured data |
| created_at | TIMESTAMP | When record was created |
| updated_at | TIMESTAMP | When record was last updated |

#### `document_chunks` Table  
**Purpose**: Stores vectorized text chunks for search  
**Written by**: Separate vectorizer worker (NOT this system)

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Chunk identifier |
| document_id | UUID | Foreign key to documents.id |
| content | TEXT | Chunk text content |
| metadata | JSONB | Speaker, timing, thread info |
| embedding | vector(768) | 768-dimensional vector embedding |

### 📁 Supabase Storage

#### Bucket: `meetings`
**Path Structure**: `transcripts/{filename}`  
**Naming Convention**: `YYYY-MM-DD - Meeting Title.md`

**Examples**:
- `2025-09-15 - Weekly Team Standup.md`
- `2025-09-14 - Product Review Meeting.md`
- `2025-09-13 - Client Strategy Session.md`

**Content Format**: Structured Markdown with:
- Meeting metadata (date, duration, participants)
- Summary and key points
- Action items
- Full transcript with speaker attribution

### 🗂️ File Organization

```
Supabase Storage: meetings/
└── transcripts/
    ├── 2025-09-15 - Weekly Team Standup.md
    ├── 2025-09-15 - Product Review Meeting.md
    ├── 2025-09-14 - Client Strategy Session.md
    └── ... (487+ files currently stored)
```

## How It's Triggered

### 1. ⏰ Automatic Cron Schedule
**Frequency**: Every 30 minutes  
**Schedule**: `*/30 * * * *`  
**Action**: Syncs recent transcripts from Fireflies

### 2. 🎣 Webhook Events
**URL**: `https://worker-alleato-fireflies-rag.megan-d14.workers.dev/webhook/fireflies`  
**Trigger**: When meetings complete in Fireflies  
**Action**: Immediately processes the new transcript  
**Security**: HMAC signature verification (optional)

### 3. 📞 Manual API Calls

#### Batch Sync
```bash
curl -X POST https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/sync \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}'
```

#### Single Transcript
```bash
curl -X POST https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/process \
  -H "Content-Type: application/json" \
  -d '{"transcript_id": "01K57347ME7T5K90M7RV121HN6"}'
```

## API Endpoints

### Production URL
`https://worker-alleato-fireflies-rag.megan-d14.workers.dev`

### Available Endpoints

#### Health Check
```http
GET /api/health

Response:
{
  "status": "healthy",
  "ts": "2025-09-15T21:00:00Z",
  "service": "fireflies-ingest"
}
```

#### Sync Recent Transcripts
```http
POST /api/sync
Content-Type: application/json

{
  "limit": 25  // Optional: number of transcripts to sync
}

Response:
{
  "success": true,
  "processed": 15,
  "failed": 0,
  "errors": []
}
```

#### Process Single Transcript
```http
POST /api/process
Content-Type: application/json

{
  "transcript_id": "01K57347ME7T5K90M7RV121HN6"
}

Response:
{
  "ok": true,
  "transcript_id": "01K57347ME7T5K90M7RV121HN6"
}
```

#### Get Analytics
```http
GET /api/analytics

Response:
{
  "meetings": {
    "total": 487,
    "lastWeek": 25,
    "lastMonth": 120
  },
  "chunks": {
    "total": 0  // Populated by vectorizer worker
  },
  "storage": {
    "filesCount": 86,
    "totalSize": "125 MB"
  }
}
```

#### Search (Requires Vectorizer)
```http
POST /api/search  ⚠️ Delegates to separate vectorizer worker
Content-Type: application/json

{
  "query": "action items from product meetings"
}
```

#### Webhook Endpoint
```http
POST /webhook/fireflies
Content-Type: application/json
X-Fireflies-Signature: [HMAC signature]

{
  "event": "meeting.completed",
  "transcript_id": "01K57347ME7T5K90M7RV121HN6"
}
```

## Configuration

### Required Secrets
Set using `npx wrangler secret put [NAME]`:

```bash
npx wrangler secret put FIREFLIES_API_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY  
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put FIREFLIES_WEBHOOK_SECRET  # Optional
```

### Environment Variables (wrangler.jsonc)

```json
{
  "vars": {
    "SUPABASE_URL": "https://lgveqfnpkxvzbnnwuled.supabase.co",
    "RATE_LIMIT_REQUESTS": 100,
    "RATE_LIMIT_WINDOW": 60,
    "SYNC_BATCH_SIZE": 25,
    "VECTOR_CACHE_TTL": 3600,
    "ENABLE_REALTIME": false
  }
}
```

### Required Cloudflare Resources

```json
{
  "hyperdrive": [{
    "binding": "HYPERDRIVE",
    "id": "81ca12eec05e4eeab6334050ae1a4dda"
  }],
  "kv_namespaces": [{
    "binding": "CACHE", 
    "id": "246a76714a2a49d5852dd7831dd6d731"
  }],
  "ai": {
    "binding": "AI"
  }
}
```

## Deployment

### Prerequisites

1. **Cloudflare Account** with Workers enabled
2. **Supabase Project** with:
   - PostgreSQL database
   - Storage bucket named "meetings"
3. **Fireflies.ai API Key**

### Quick Deploy

```bash
# Clone and install
git clone [repository-url]
cd pm-rag-fireflies-ingest
pnpm install

# Set secrets
npx wrangler secret put FIREFLIES_API_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put SUPABASE_ANON_KEY

# Deploy
npx wrangler deploy
```

### Database Setup

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- Create tables (see supabase-schema.sql)
-- Run the schema file in Supabase SQL Editor
```

### Local Development

```bash
# Requires Hyperdrive connection string for local dev
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://..." pnpm dev

# Test endpoints
curl http://localhost:62872/api/health
```

## Usage Examples

### Daily Sync Script
```javascript
// Sync transcripts from last 24 hours
async function dailySync() {
  const response = await fetch('https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 50 })
  });
  
  const result = await response.json();
  console.log(`Processed: ${result.processed}, Failed: ${result.failed}`);
}
```

### Check System Status
```javascript
async function checkStatus() {
  // Health check
  const health = await fetch('https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/health');
  console.log(await health.json());
  
  // Analytics
  const analytics = await fetch('https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/analytics');
  const stats = await analytics.json();
  console.log(`Total meetings: ${stats.meetings.total}`);
  console.log(`Storage files: ${stats.storage.filesCount}`);
}
```

### Process Specific Meeting
```javascript
async function processSpecificMeeting(transcriptId) {
  const response = await fetch('https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript_id: transcriptId })
  });
  
  return await response.json();
}
```

## Monitoring

### View Logs
```bash
# Real-time logs
npx wrangler tail

# Filter for errors
npx wrangler tail --format=pretty | grep ERROR
```

### Key Metrics to Monitor

1. **Sync Success Rate**: Check `/api/analytics` for failed processing
2. **Storage Growth**: Monitor Supabase Storage usage  
3. **Database Size**: Track `documents` table growth
4. **Processing Time**: Watch for timeout issues
5. **Rate Limits**: Monitor for 429 errors

### Test Scripts

```bash
# Test Fireflies connection
node scripts/test-fireflies-fetch.js

# Check database status  
node scripts/check-documents.js

# Verify storage files
node scripts/check-storage.js
```

## Current Status

### Production Deployment
- **Live URL**: https://worker-alleato-fireflies-rag.megan-d14.workers.dev
- **Database**: 487+ documents successfully ingested
- **Storage**: 86+ transcript files stored
- **Cron**: Running every 30 minutes automatically

### Recent Transcripts Processed
- Goodwill Bloomington RFI Update (2025-09-15)
- Weekly Ops Updates (2025-09-15)  
- Executive meetings (2025-09-15)
- Project consultations (2025-09-15)

### File Naming Examples
New format (implemented):
- `2025-09-15 - Goodwill Bloomington RFI Update.md`

Old format (legacy files):
- `01K57347ME7T5K90M7RV121HN6.md`

## Integration with Vectorizer Worker

This ingest worker is designed to work with a separate vectorizer worker:

### What This Worker Provides
- Clean, structured transcript data in `documents` table
- Standardized metadata format
- Reliable file storage in Supabase

### What Vectorizer Worker Should Do
- Read from `documents` table
- Chunk transcript content (speaker-aware)
- Generate embeddings using OpenAI/Cloudflare AI
- Populate `document_chunks` table
- Enable semantic search functionality

### Integration Flow
```
Ingest Worker → documents table → Vectorizer Worker → document_chunks table
```

## Troubleshooting

### Common Issues

#### Transcript Not Processing
1. Check Fireflies API key: `npx wrangler secret list`
2. Verify transcript exists in Fireflies
3. Check worker logs: `npx wrangler tail`

#### Database Connection Issues  
1. Verify Hyperdrive configuration
2. Check Supabase service key
3. Test with: `node scripts/check-documents.js`

#### Storage Upload Failures
1. Check Supabase Storage permissions
2. Verify "meetings" bucket exists
3. Test with: `node scripts/check-storage.js`

#### Webhook Not Working
1. Verify webhook URL in Fireflies settings
2. Check HMAC signature if enabled
3. Monitor `/webhook/fireflies` endpoint logs

### Debug Mode
Enable detailed logging by checking worker logs:
```bash
npx wrangler tail --format=pretty
```

### Performance Issues
- **Large batches**: Reduce `SYNC_BATCH_SIZE` 
- **Timeouts**: Process transcripts individually
- **Rate limits**: Increase `RATE_LIMIT_WINDOW`

## Next Steps

To build a complete RAG system:

1. **Deploy Vectorizer Worker**: 
   - Chunk transcripts from `documents` table
   - Generate embeddings 
   - Populate `document_chunks` table

2. **Enable Search**:
   - Configure vectorizer worker URL
   - Test `/api/search` endpoint

3. **Add Chat Interface**:
   - Use retrieved chunks as context
   - Integrate with Claude/GPT for answers

## Support

- **Logs**: `npx wrangler tail`
- **Test Scripts**: See `scripts/` directory
- **Configuration**: Check `CLAUDE.md` for development guidance